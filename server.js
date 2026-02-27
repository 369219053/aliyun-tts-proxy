const express = require('express');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS 跨域支持
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Token 缓存
let tokenCache = { id: null, expireTime: 0 };

// 生成32位唯一ID
function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

// 获取阿里云 NLS Token（带缓存）
async function getNlsToken() {
  if (tokenCache.id && Date.now() < tokenCache.expireTime) {
    return tokenCache.id;
  }

  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;

  const params = {
    AccessKeyId: accessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: generateId(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2018-05-18'
  };

  const sortedKeys = Object.keys(params).sort();
  const queryStr = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const stringToSign = `POST&${encodeURIComponent('/')}&${encodeURIComponent(queryStr)}`;
  const signature = crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
  params.Signature = signature;

  const postData = new URLSearchParams(params).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'nls-meta.cn-shanghai.aliyuncs.com',
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.Token) {
            tokenCache.id = result.Token.Id;
            // 提前1分钟过期，防止边缘情况
            tokenCache.expireTime = result.Token.ExpireTime * 1000 - 60000;
            resolve(result.Token.Id);
          } else {
            reject(new Error(result.Message || `获取Token失败: ${data}`));
          }
        } catch (e) {
          reject(new Error(`解析Token响应失败: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 通过 WebSocket 调用阿里云 CosyVoice TTS
function synthesizeSpeech(text, voice, format, token) {
  return new Promise((resolve, reject) => {
    const appkey = process.env.ALIYUN_APPKEY;
    const wsUrl = `wss://nls-gateway-cn-beijing.aliyuncs.com/ws/v1?token=${token}`;
    const ws = new WebSocket(wsUrl);
    const taskId = generateId();
    const audioChunks = [];

    // 30秒超时保护
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket 超时，请检查配置'));
    }, 30000);

    ws.on('open', () => {
      // 第一步：发送 StartSynthesis 指令
      ws.send(JSON.stringify({
        header: {
          message_id: generateId(),
          task_id: taskId,
          namespace: 'FlowingSpeechSynthesizer',
          name: 'StartSynthesis',
          appkey
        },
        payload: {
          voice: voice || 'longxiaochun',
          format: format || 'mp3',
          sample_rate: 16000,
          volume: 50,
          speech_rate: 0,
          pitch_rate: 0
        }
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // 收到音频二进制数据
        audioChunks.push(Buffer.from(data));
      } else {
        const msg = JSON.parse(data.toString());
        const name = msg.header?.name;

        if (name === 'SynthesisStarted') {
          // 第二步：发送文本内容
          ws.send(JSON.stringify({
            header: { message_id: generateId(), task_id: taskId, namespace: 'FlowingSpeechSynthesizer', name: 'RunSynthesis', appkey },
            payload: { text }
          }));
          // 第三步：发送 StopSynthesis，通知服务器文本结束
          ws.send(JSON.stringify({
            header: { message_id: generateId(), task_id: taskId, namespace: 'FlowingSpeechSynthesizer', name: 'StopSynthesis', appkey }
          }));
        } else if (name === 'SynthesisCompleted') {
          clearTimeout(timeout);
          ws.close();
          resolve(Buffer.concat(audioChunks));
        } else if (name === 'TaskFailed') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.header?.status_message || '语音合成失败'));
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 主接口：文本转语音
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'longxiaochun', format = 'mp3' } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: '缺少 text 参数' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ success: false, error: '文本超过2000字符限制' });
    }

    console.log(`[TTS] 开始合成，文本长度: ${text.length}，音色: ${voice}`);

    // 1. 获取 Token
    const token = await getNlsToken();

    // 2. 调用阿里云 TTS
    const audioBuffer = await synthesizeSpeech(text, voice, format, token);
    console.log(`[TTS] 合成完成，音频大小: ${audioBuffer.length} bytes`);

    // 3. 上传到 Supabase Storage
    const fileName = `tts/${Date.now()}_${generateId().slice(0, 8)}.${format}`;
    const contentType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';

    const { error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, audioBuffer, { contentType, upsert: true });

    if (uploadError) throw new Error(`Supabase 上传失败: ${uploadError.message}`);

    // 4. 获取公网 URL
    const { data: { publicUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(fileName);

    console.log(`[TTS] 上传成功: ${publicUrl}`);
    res.json({ success: true, url: publicUrl, char_count: text.length });

  } catch (error) {
    console.error('[TTS] 错误:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 阿里云TTS代理服务 运行在端口 ${PORT}`);
});

