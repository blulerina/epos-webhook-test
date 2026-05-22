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

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const value = req.body.entry[0].changes[0].value;

    if (!value.messages) {
      console.log('Status update received, skipping...');
      return;
    }

    const message = value.messages[0];
    const customerNumber = message.from;
    const customerName = value.contacts[0].profile.name;
    const messageId = message.id;
    const customerMessage = message.text?.body || '';

    // Step 1: Mark message as read
    await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      })
    });

    console.log(`Marked message as read from ${customerNumber}`);

    // Step 2: End any existing typing indicator (reset)
    await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: customerNumber,
        type: 'typing_indicator',
        typing_indicator: { type: 'end' }
      })
    });

    console.log(`Reset typing indicator for ${customerNumber}`);

    // Step 3: Small pause to let WhatsApp register the reset
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 4: Start fresh typing indicator
    await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: customerNumber,
        type: 'typing_indicator',
        typing_indicator: { type: 'text' }
      })
    });

    console.log(`Sent fresh typing indicator to ${customerNumber}`);

    // Step 5: Check if first time customer
    if (!seenCustomers.has(customerNumber)) {
      seenCustomers.set(customerNumber, true);
      console.log(`First time customer ${customerName}, sending template...`);

      // Wait 1 second before sending welcome template
      await new Promise(resolve => setTimeout(resolve, 1000));

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
      console.log(`Returning customer ${customerName}, sending AI reply...`);

      // Step 6: Call Groq API while keeping typing indicator alive
      const groqStart = Date.now();

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
              {
                role: 'user',
                content: customerMessage
              }
            ]
          })
        }),
        // Minimum wait time so typing indicator is visible
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      const groqTime = Date.now() - groqStart;
      console.log(`Groq response time: ${groqTime}ms`);

      const groqData = await groqResponse.json();
      console.log('Groq API response:', JSON.stringify(groqData));
      const aiReply = groqData.choices[0].message.content;

      console.log(`AI reply: ${aiReply}`);

      // Step 7: End typing indicator before sending message
      await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: customerNumber,
          type: 'typing_indicator',
          typing_indicator: { type: 'end' }
        })
      });

      console.log(`Ended typing indicator for ${customerNumber}`);

      // Step 8: Send AI reply
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
});

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});