const express = require('express');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

// 生成32位唯一ID（无横线）
function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 通过 DashScope CosyVoice WebSocket API 合成语音
 * 文档：https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api
 *
 * @param {string} text - 待合成文本
 * @param {string} voice - 音色（系统音色名称 或 声音复刻的 voice_id）
 * @param {string} model - 语音合成模型（cosyvoice-v3-flash / cosyvoice-v3-plus 等）
 * @param {string} format - 音频格式（mp3 / wav / opus）
 * @returns {Promise<Buffer>} - 合成后的音频二进制数据
 */
function synthesizeSpeech(text, voice, model, format, userApiKey) {
  return new Promise((resolve, reject) => {
    const apiKey = userApiKey || process.env.DASHSCOPE_API_KEY;
    if (!apiKey) return reject(new Error('缺少 apikey 参数，且未设置 DASHSCOPE_API_KEY 环境变量'));

    // DashScope WebSocket 接入点（中国内地）
    const wsUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
    const taskId = generateId();
    const audioChunks = [];
    let isSettled = false; // 防止多次 resolve/reject

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `bearer ${apiKey}`
      }
    });

    // 60秒超时保护
    const timeout = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        ws.terminate();
        reject(new Error('WebSocket 超时（60秒），请检查 DASHSCOPE_API_KEY 是否有效'));
      }
    }, 60000);

    ws.on('open', () => {
      console.log('[TTS] WebSocket 已连接 DashScope');

      // 第一步：发送 run-task 指令（指定模型、音色、格式等参数）
      const runTask = {
        header: {
          action: 'run-task',
          task_id: taskId,
          streaming: 'duplex'
        },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: model || 'cosyvoice-v3-flash',
          parameters: {
            text_type: 'PlainText',
            voice: voice || 'longanyang',
            format: format || 'mp3',
            sample_rate: 22050,
            volume: 50,
            rate: 1,
            pitch: 1
          },
          input: {} // 必须包含，不能省略
        }
      };
      ws.send(JSON.stringify(runTask));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // 收到音频二进制数据，按顺序追加
        audioChunks.push(Buffer.from(data));
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        const event = msg.header?.event;

        if (event === 'task-started') {
          console.log('[TTS] 任务已开始，发送文本...');

          // 第二步：发送待合成文本
          ws.send(JSON.stringify({
            header: {
              action: 'continue-task',
              task_id: taskId,
              streaming: 'duplex'
            },
            payload: {
              input: { text }
            }
          }));

          // 第三步：立即发送 finish-task，通知服务端文本发送完毕
          ws.send(JSON.stringify({
            header: {
              action: 'finish-task',
              task_id: taskId,
              streaming: 'duplex'
            },
            payload: { input: {} } // 必须包含，不能省略
          }));

        } else if (event === 'task-finished') {
          console.log('[TTS] 任务完成，音频块数量:', audioChunks.length);
          clearTimeout(timeout);
          ws.close();
          if (!isSettled) {
            isSettled = true;
            resolve(Buffer.concat(audioChunks));
          }

        } else if (event === 'task-failed') {
          const errMsg = msg.header?.error_message || '语音合成失败';
          console.error('[TTS] 任务失败:', errMsg);
          clearTimeout(timeout);
          ws.close();
          if (!isSettled) {
            isSettled = true;
            reject(new Error(errMsg));
          }
        }
        // result-generated 事件无需处理（音频数据通过 binary 通道收取）
      } catch (e) {
        console.warn('[TTS] 解析消息失败:', e.message);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (!isSettled) {
        isSettled = true;
        reject(new Error(`WebSocket 错误: ${err.message}`));
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (!isSettled) {
        isSettled = true;
        reject(new Error(`WebSocket 意外关闭，code: ${code}，原因: ${reason?.toString() || '未知'}`));
      }
    });
  });
}

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 主接口：文本转语音 → 上传 Supabase → 返回公网 URL
app.post('/api/tts', async (req, res) => {
  try {
    const {
      text,
      voice = 'longanyang',          // 音色：系统音色名称 或 声音复刻的 voice_id
      model = 'cosyvoice-v3-flash',  // 模型：与创建复刻音色时的 target_model 保持一致
      format = 'mp3',
      apikey                         // 用户自己的 DashScope API Key（优先使用，否则用环境变量）
    } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: '缺少 text 参数' });
    }
    if (text.length > 5000) {
      return res.status(400).json({ success: false, error: '文本超过5000字符限制' });
    }

    console.log(`[TTS] 开始合成，文本长度: ${text.length}，音色: ${voice}，模型: ${model}`);

    // 1. 调用 DashScope CosyVoice WebSocket TTS
    const audioBuffer = await synthesizeSpeech(text, voice, model, format, apikey);
    console.log(`[TTS] 合成完成，音频大小: ${audioBuffer.length} bytes`);

    // 2. 上传到 Supabase Storage
    const fileName = `tts/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${format}`;
    const contentTypeMap = { wav: 'audio/wav', opus: 'audio/ogg', mp3: 'audio/mpeg' };
    const contentType = contentTypeMap[format] || 'audio/mpeg';

    const { error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, audioBuffer, { contentType, upsert: true });

    if (uploadError) throw new Error(`Supabase 上传失败: ${uploadError.message}`);

    // 3. 获取公网 URL
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
  console.log(`🚀 DashScope CosyVoice TTS 代理服务 运行在端口 ${PORT}`);
});

