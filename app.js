const express = require('express');
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const accessToken = process.env.ACCESS_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

// Track first time customers
const seenCustomers = new Map();

// Track per-conversation state for the typing indicator investigation.
// Key: customer phone number. Value: { lastOutboundSentAt, lastOutboundDeliveredAt, lastOutboundWamid }
const conversationState = new Map();

// ---- Logging helpers --------------------------------------------------------

const nowMs = () => Date.now();
const isoMs = (ms) => new Date(ms).toISOString();

// Every log line for one turn gets the same turnId so you can grep one turn out of the log.
const makeTurnId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function dbg(turnId, conv, event, extra = {}) {
  // Single-line JSON log so it's easy to parse later (e.g. jq) and easy to grep.
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
  // Respond to Meta immediately to prevent retries
  res.status(200).end();

  const webhookReceivedAt = nowMs();
  console.log(`\n\nWebhook received ${isoMs(webhookReceivedAt)}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const value = req.body.entry[0].changes[0].value;

    // ---- Handle status webhooks (sent / delivered / read) -------------------
    // Previously these were skipped. We now log them because they tell us when
    // OUR previous reply actually landed on the customer's device, which is the
    // most precise version of "time since last outbound activity".
    if (value.statuses) {
      for (const status of value.statuses) {
        const conv = status.recipient_id;
        const wamid = status.id;
        const statusType = status.status; // 'sent' | 'delivered' | 'read' | 'failed'
        const statusTsMs = Number(status.timestamp) * 1000;

        dbg('status', conv, 'outbound_status', {
          wamid,
          statusType,
          metaTimestamp: isoMs(statusTsMs),
          receivedAt: isoMs(nowMs()),
          deliveryLatencyMs: nowMs() - statusTsMs
        });

        // Update conversation state when our outbound message is delivered.
        // "delivered" = landed on customer's device. This is the variable we
        // most care about for the typing-indicator hypothesis.
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

    // The key measurement: time since our last outbound message in this conversation.
    // We compute two flavours because either could matter:
    //   - sinceLastOutboundSent: time since we POSTed our last reply
    //   - sinceLastOutboundDelivered: time since Meta says our last reply was delivered
    //                                 to the customer's device (more accurate, but
    //                                 requires the delivered-status webhook to have arrived)
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
      // Lag between when Meta says the user sent it vs when our server got the webhook.
      // Spikes here can explain why a typing indicator feels "late".
      webhookLagMs: webhookReceivedAt - metaMessageTsMs,
      // THE KEY VARIABLES for the hypothesis:
      sinceLastOutboundSentMs: sinceLastOutboundSent,
      sinceLastOutboundDeliveredMs: sinceLastOutboundDelivered,
      lastOutboundWamid: state.lastOutboundWamid || null,
      preview: customerMessage.slice(0, 80)
    });

    // ---- Step 1: Mark as read + typing indicator ----------------------------
    const typingCalledAt = nowMs();
    dbg(turnId, customerNumber, 'typing_call_start', {
      messageIdUsed: messageId,
      // Confirm the message_id we're sending IS the one we just received
      // (rules out the "stale message_id" alternative hypothesis).
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
      typingBody = await typingResp.text(); // read as text in case it's not JSON on errors
    } catch (e) {
      dbg(turnId, customerNumber, 'typing_call_error', { error: e.message });
    }

    const typingRespondedAt = nowMs();
    dbg(turnId, customerNumber, 'typing_call_end', {
      httpStatus: typingResp?.status,
      latencyMs: typingRespondedAt - typingCalledAt,
      responseBody: typingBody // full body, not just status — Meta sometimes returns 200 with an embedded error
    });

    // ---- Step 2: First-time customer → template -----------------------------
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

      // Update conversation state so the NEXT turn can compute "time since last outbound".
      conversationState.set(customerNumber, {
        ...state,
        lastOutboundSentAt: replyRespondedAt,
        lastOutboundWamid: outboundWamid,
        lastOutboundDeliveredAt: null // will be filled in when delivered-status webhook arrives
      });

      return;
    }

    // ---- Step 3: Returning customer → AI reply ------------------------------
    dbg(turnId, customerNumber, 'flow_branch', { branch: 'returning_ai_reply' });

    const groqStart = nowMs();
    dbg(turnId, customerNumber, 'groq_call_start', {});

    const [groqResponse] = await Promise.all([
      fetch('https://api.groq.com/openai/v1/chat/completions', {
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
      }),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);

    const groqEnd = nowMs();
    dbg(turnId, customerNumber, 'groq_call_end', {
      httpStatus: groqResponse.status,
      latencyMs: groqEnd - groqStart
    });

    const groqData = await groqResponse.json();
    const aiReply = groqData.choices?.[0]?.message?.content || '(no reply)';

    const replyCalledAt = nowMs();
    dbg(turnId, customerNumber, 'reply_call_start', {
      kind: 'text',
      gapTypingToReplyMs: replyCalledAt - typingRespondedAt,
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

    // Update conversation state for the next turn.
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