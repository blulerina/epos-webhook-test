const express = require('express');
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const accessToken = process.env.ACCESS_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

// Total time the typing bubble should stay visible before the reply lands.
// Per Darren's instruction: 15s dwell to test whether longer bubble dwell time
// makes the indicator render more consistently. AI replies only.
const REPLY_DWELL_MS = 15000;

// Track first time customers
const seenCustomers = new Map();

// Track per-conversation state for the typing indicator investigation.
const conversationState = new Map();

// ---- Logging helpers --------------------------------------------------------

const nowMs = () => Date.now();
const isoMs = (ms) => new Date(ms).toISOString();

const makeTurnId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function dbg(turnId, conv, event, extra = {}) {
  const line = {
    turnId,
    conv,
    event,
    ts: isoMs(nowMs()),
    ...extra
  };
  console.log('DBG ' + JSON.stringify(line));
}

// -----------------------------------------------------------------------------

app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

app.post('/', async (req, res) => {
  res.status(200).end();

  const webhookReceivedAt = nowMs();
  console.log(`\n\nWebhook received ${isoMs(webhookReceivedAt)}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const value = req.body.entry[0].changes[0].value;

    // ---- Handle status webhooks (sent / delivered / read) -------------------
    if (value.statuses) {
      for (const status of value.statuses) {
        const conv = status.recipient_id;
        const wamid = status.id;
        const statusType = status.status;
        const statusTsMs = Number(status.timestamp) * 1000;

        dbg('status', conv, 'outbound_status', {
          wamid,
          statusType,
          metaTimestamp: isoMs(statusTsMs),
          receivedAt: isoMs(nowMs()),
          deliveryLatencyMs: nowMs() - statusTsMs
        });

        const state = conversationState.get(conv) || {};
        if (statusType === 'delivered' && state.lastOutboundWamid === wamid) {
          state.lastOutboundDeliveredAt = statusTsMs;
          conversationState.set(conv, state);
        }
      }
      return;
    }

    if (!value.messages) {
      console.log('Unknown webhook shape, skipping...');
      return;
    }

    // ---- Handle inbound user message ----------------------------------------
    const message = value.messages[0];
    const customerNumber = message.from;
    const customerName = value.contacts[0].profile.name;
    const messageId = message.id;
    const customerMessage = message.text?.body || '';
    const metaMessageTsMs = Number(message.timestamp) * 1000;

    const turnId = makeTurnId();
    const state = conversationState.get(customerNumber) || {};

    const sinceLastOutboundSent = state.lastOutboundSentAt
      ? webhookReceivedAt - state.lastOutboundSentAt
      : null;
    const sinceLastOutboundDelivered = state.lastOutboundDeliveredAt
      ? webhookReceivedAt - state.lastOutboundDeliveredAt
      : null;

    dbg(turnId, customerNumber, 'inbound_received', {
      messageId,
      customerName,
      metaMessageTs: isoMs(metaMessageTsMs),
      webhookReceivedAt: isoMs(webhookReceivedAt),
      webhookLagMs: webhookReceivedAt - metaMessageTsMs,
      sinceLastOutboundSentMs: sinceLastOutboundSent,
      sinceLastOutboundDeliveredMs: sinceLastOutboundDelivered,
      lastOutboundWamid: state.lastOutboundWamid || null,
      preview: customerMessage.slice(0, 80)
    });

    // ---- Step 1: Mark as read + typing indicator ----------------------------
    const typingCalledAt = nowMs();
    dbg(turnId, customerNumber, 'typing_call_start', {
      messageIdUsed: messageId,
      messageIdMatchesIncoming: messageId === message.id
    });

    let typingResp, typingBody;
    try {
      typingResp = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' }
        })
      });
      typingBody = await typingResp.text();
    } catch (e) {
      dbg(turnId, customerNumber, 'typing_call_error', { error: e.message });
    }

    const typingRespondedAt = nowMs();
    dbg(turnId, customerNumber, 'typing_call_end', {
      httpStatus: typingResp?.status,
      latencyMs: typingRespondedAt - typingCalledAt,
      responseBody: typingBody
    });

    // ---- Step 2: First-time customer → template (NO dwell delay) ------------
    if (!seenCustomers.has(customerNumber)) {
      seenCustomers.set(customerNumber, true);
      dbg(turnId, customerNumber, 'flow_branch', { branch: 'first_time_template' });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const replyCalledAt = nowMs();
      dbg(turnId, customerNumber, 'reply_call_start', {
        kind: 'template',
        gapTypingToReplyMs: replyCalledAt - typingRespondedAt
      });

      const replyResp = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: customerNumber,
          type: 'template',
          template: {
            name: 'epos_welcome_msg',
            language: { code: 'en' },
            components: [{
              type: 'body',
              parameters: [{ type: 'text', text: customerName }]
            }]
          }
        })
      });

      const replyBody = await replyResp.text();
      const replyRespondedAt = nowMs();
      const parsed = safeJson(replyBody);
      const outboundWamid = parsed?.messages?.[0]?.id || null;

      dbg(turnId, customerNumber, 'reply_call_end', {
        kind: 'template',
        httpStatus: replyResp.status,
        latencyMs: replyRespondedAt - replyCalledAt,
        outboundWamid,
        responseBody: replyBody
      });

      conversationState.set(customerNumber, {
        ...state,
        lastOutboundSentAt: replyRespondedAt,
        lastOutboundWamid: outboundWamid,
        lastOutboundDeliveredAt: null
      });

      return;
    }

    // ---- Step 3: Returning customer → AI reply (15s DWELL) ------------------
    // The reply is sent exactly REPLY_DWELL_MS after the typing call started.
    // The LLM call runs during the wait, so its latency is absorbed into the dwell
    // rather than stacking on top. If the LLM takes longer than the dwell, we just
    // send as soon as it's done.
    dbg(turnId, customerNumber, 'flow_branch', { branch: 'returning_ai_reply' });

    const dwellTargetMs = typingCalledAt + REPLY_DWELL_MS;

    const groqStart = nowMs();
    dbg(turnId, customerNumber, 'groq_call_start', {
      dwellTargetTs: isoMs(dwellTargetMs),
      msUntilDwellExpires: dwellTargetMs - groqStart
    });

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are a helpful customer service assistant for EPOS Malaysia, a company that provides all-in-one POS solutions for SMEs. Be friendly, concise and helpful. The customer's name is ${customerName}.`
          },
          { role: 'user', content: customerMessage }
        ]
      })
    });

    const groqEnd = nowMs();
    dbg(turnId, customerNumber, 'groq_call_end', {
      httpStatus: groqResponse.status,
      latencyMs: groqEnd - groqStart
    });

    const groqData = await groqResponse.json();
    const aiReply = groqData.choices?.[0]?.message?.content || '(no reply)';

    // Wait out the remainder of the dwell window. If the LLM already took >15s,
    // remainingDwellMs will be <= 0 and we skip the wait.
    const remainingDwellMs = dwellTargetMs - nowMs();
    dbg(turnId, customerNumber, 'dwell_wait', {
      remainingDwellMs: Math.max(0, remainingDwellMs),
      llmExceededDwell: remainingDwellMs < 0
    });
    if (remainingDwellMs > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingDwellMs));
    }

    const replyCalledAt = nowMs();
    dbg(turnId, customerNumber, 'reply_call_start', {
      kind: 'text',
      gapTypingToReplyMs: replyCalledAt - typingRespondedAt,
      gapTypingCallToReplyMs: replyCalledAt - typingCalledAt, // should be ~15000
      replyPreview: aiReply.slice(0, 80)
    });

    const replyResp = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: customerNumber,
        type: 'text',
        text: { body: aiReply }
      })
    });

    const replyBody = await replyResp.text();
    const replyRespondedAt = nowMs();
    const parsed = safeJson(replyBody);
    const outboundWamid = parsed?.messages?.[0]?.id || null;

    dbg(turnId, customerNumber, 'reply_call_end', {
      kind: 'text',
      httpStatus: replyResp.status,
      latencyMs: replyRespondedAt - replyCalledAt,
      outboundWamid,
      responseBody: replyBody
    });

    conversationState.set(customerNumber, {
      ...state,
      lastOutboundSentAt: replyRespondedAt,
      lastOutboundWamid: outboundWamid,
      lastOutboundDeliveredAt: null
    });

  } catch (err) {
    console.log('Error:', err.message, err.stack);
  }
});

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});