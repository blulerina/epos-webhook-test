const express = require('express');
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const accessToken = process.env.ACCESS_TOKEN;

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
    const message = req.body.entry[0].changes[0].value.messages[0];
    const customerNumber = message.from;
    const customerName = req.body.entry[0].changes[0].value.contacts[0].profile.name;

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

    console.log(`Replied to ${customerName} (${customerNumber}) with epos_welcome template`);
  } catch (err) {
    console.log('No message to reply to or error:', err.message);
  }

  res.status(200).end();
});

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});