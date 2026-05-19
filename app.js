const express = require('express');
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const accessToken = process.env.ACCESS_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;

// Track first time customers
const seenCustomers = new Map();

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
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const value = req.body.entry[0].changes[0].value;

    if (!value.messages) {
      console.log('Status update received, skipping...');
      return res.status(200).end();
    }

    const message = value.messages[0];
    const customerNumber = message.from;
    const customerName = value.contacts[0].profile.name;
    const messageId = message.id;
    const customerMessage = message.text?.body || '';

    // Step 1: Send typing indicator
    await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
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

    console.log(`Sent typing indicator to ${customerNumber}`);

    // Step 2: Wait 1 second
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Check if first time customer
    if (!seenCustomers.has(customerNumber)) {
      // First time — send epos_welcome template
      seenCustomers.set(customerNumber, true);
      console.log(`First time customer ${customerName} (${customerNumber}), sending template...`);

      await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
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

      console.log(`Sent epos_welcome template to ${customerName}`);

    } else {
      // Returning customer — send AI reply
      console.log(`Returning customer ${customerName} (${customerNumber}), sending AI reply...`);

      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: `You are a helpful customer service assistant for EPOS Malaysia, a company that provides all-in-one POS solutions for SMEs. Be friendly, concise and helpful. The customer's name is ${customerName}.`
            },
            {
              role: 'user',
              content: customerMessage
            }
          ]
        })
      });

      const openaiData = await openaiResponse.json();
      const aiReply = openaiData.choices[0].message.content;

      console.log(`AI reply: ${aiReply}`);

      await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
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

      console.log(`Sent AI reply to ${customerName}`);
    }

  } catch (err) {
    console.log('Error:', err.message);
  }

  res.status(200).end();
});

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});