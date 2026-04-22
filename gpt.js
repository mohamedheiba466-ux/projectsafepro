exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return resp(405, { error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return resp(500, { choices: [{ message: { content: '⚠️ GEMINI_API_KEY غير مُعرّف' } }] });
    }

    const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

    let systemInstruction = null;
    const contents = [];
    for (const msg of (body.messages || [])) {
      if (!msg || !msg.content) continue;
      if (msg.role === 'system') {
        const prev = systemInstruction ? systemInstruction.parts[0].text + '\n\n' : '';
        const txt = typeof msg.content === 'string'
          ? msg.content
          : msg.content.map(function (p) { return p.text || ''; }).join('\n');
        systemInstruction = { parts: [{ text: prev + txt }] };
      } else {
        let parts = [];
        if (typeof msg.content === 'string') {
          parts = [{ text: msg.content }];
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              parts.push({ text: part.text || '' });
            } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
              const url = part.image_url.url;
              if (url.startsWith('data:')) {
                const commaIdx = url.indexOf(',');
                const mimeType = url.substring(5, commaIdx).split(';')[0];
                const b64data = url.substring(commaIdx + 1);
                parts.push({ inlineData: { mimeType: mimeType, data: b64data } });
              }
            }
          }
        }
        if (parts.length > 0) {
          contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: parts });
        }
      }
    }

    const geminiBody = {
      contents: contents,
      generationConfig: {
        maxOutputTokens: body.max_tokens || 4096,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
        topP: 0.95
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
      ]
    };
    if (systemInstruction) geminiBody.systemInstruction = systemInstruction;

    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });
    const data = await geminiRes.json();

    let replyText = '';
    if (data && data.candidates && data.candidates[0]) {
      const cand = data.candidates[0];
      if (cand.content && cand.content.parts && cand.content.parts.length) {
        replyText = cand.content.parts.map(function (p) { return p.text || ''; }).join('');
      } else if (cand.finishReason === 'SAFETY') {
        replyText = '⚠️ تم حجب الرد من فلاتر السلامة. أعد صياغة السؤال.';
      } else {
        replyText = '⚠️ لم يكتمل الرد (' + (cand.finishReason || '') + ')';
      }
    } else if (data && data.error) {
      replyText = '⚠️ خطأ Gemini: ' + (data.error.message || 'غير معروف');
    } else {
      replyText = '⚠️ رد فارغ من Gemini.';
    }

    return resp(200, {
      choices: [{ message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
      model: GEMINI_MODEL
    });
  } catch (e) {
    return resp(500, { choices: [{ message: { content: '⚠️ خطأ: ' + e.message } }] });
  }
};

function resp(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}
