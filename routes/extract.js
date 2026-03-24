import express from 'express';
import 'dotenv/config';

export const extractRoutes = express.Router();

extractRoutes.post('/', async (req, res) => {
  const { base64, mediaType } = req.body;
  if (!base64) return res.status(400).json({ error: 'No file data' });
  try {
    const isPDF = mediaType === 'application/pdf';
    const cb = isPDF
      ? {type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}}
      : {type:'image',source:{type:'base64',media_type:mediaType,data:base64}};
    
    console.log('[extract] Calling Anthropic API...');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:500,messages:[{role:'user',content:[cb,{type:'text',text:'Extract invoice details. Respond ONLY with valid JSON:\n{"client":"company name","invNum":"invoice number","amount":"total with currency symbol","email":"client email or empty","due":"due date or Not specified","confidence":0-100}'}]}]})
    });
    
    const d = await r.json();
    console.log('[extract] Anthropic response:', JSON.stringify(d).slice(0,200));
    const raw = d.content?.[0]?.text || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());
    return res.json(parsed);
  } catch(err) {
    console.error('[extract] ERROR:', err.message);
    return res.status(500).json({confidence:0,client:'',invNum:'',amount:'',email:'',due:'',error:err.message});
  }
});
