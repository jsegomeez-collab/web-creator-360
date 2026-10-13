// Follow-up of the "americanos" campaign (English). Two paths, both ending when the lead replies (Instantly "stop on reply"):
//   REMINDERS_US  for those who have NOT opened their demo website: steps 2-4 of the main campaign, on days 2, 4 and 7.
//   OPENED_US     for those who DID open it: a separate Instantly campaign (INSTANTLY_CAMPAIGN_ID_FOLLOWUP_US) with 7 emails, one a day.
//                 The campaign server moves them there by itself (services/followup.js); the reminders above stop when they move.
// The variables are the English ones of leadVariables: {{business}} {{greeting}} {{city}} {{site}}.
// EDIT THE TEXT HERE, then run `node scripts/instantly-us-campaigns.js` to put it in Instantly (or paste it by hand).

// `delay` = days to wait after the previous email
export const REMINDERS_US = [
  {
    delay: 2,
    subject: 'Did you see the website for {{business}}?',
    body: `Hi {{greeting}},

Just checking that you saw the website I designed for {{business}}:

{{site}}

It takes a minute to look through. If you like it, reply "YES" with your phone number and I'll call you to set it up with your own photos and details.

Jose
Get ur Web`,
  },
  {
    delay: 2,
    subject: '{{business}} on Google',
    body: `Hi {{greeting}},

When people in {{city}} search Google for a business like yours, the ones with their own website get the call.

Yours is already designed, it only needs your photos and details:

{{site}}

Want me to finish it? Reply "YES" with your phone number and I'll call you.

Jose
Get ur Web`,
  },
  {
    delay: 3,
    subject: 'Last note about your website',
    body: `Hi {{greeting}},

This is my last email about the website for {{business}}. It will stay online a while longer:

{{site}}

If you want it later, just reply "YES" with your phone number and I'll call you to finish it.

Best,
Jose
Get ur Web`,
  },
];

// Seven emails, one a day, for the ones who opened the website
export const OPENED_US = [
  {
    delay: 1,
    subject: 'Your website for {{business}}',
    body: `Hi {{greeting}},

I saw you took a look at the website I made for {{business}}.

{{site}}

What did you think? If you'd like anything changed (colors, photos, text), tell me and I'll adjust it.

If you like it, reply "YES" with your phone number and I'll call you to get it ready.

Jose
Get ur Web`,
  },
  {
    delay: 1,
    subject: 'What did you think of the website for {{business}}?',
    body: `One quick question about the website for {{business}}:

What's the one thing you like least, or is it just not the right time?

A "not now" is fine, so I don't write more than I should. And if you like it, reply "YES" with your phone number and I'll call you.

{{site}}

Jose`,
  },
  {
    delay: 1,
    subject: 'Getting {{business}} found',
    body: `People search Google before they call anyone, and the business with its own website is the one that gets the call.

The website for {{business}} is already made, it only needs your photos and your real details:

{{site}}

Want me to finish it? Reply "YES" with your phone number and I'll call you.

Jose`,
  },
  {
    delay: 1,
    subject: 'Here is what the website for {{business}} would look like',
    body: `This is how your website would look once I finish it:

• With your photos, phone number and services
• Written for your business and your town
• So customers can find you on Google Maps and call you directly

{{site}}

If you want me to go ahead, reply "YES" with your phone number and I'll call you.

Jose`,
  },
  {
    delay: 1,
    subject: 'Should I call you about the website for {{business}}?',
    body: `Would you rather I call you and we go through it in 10 minutes?

Reply "YES" with your phone number and the time that suits you.

{{site}}

Jose`,
  },
  {
    delay: 1,
    subject: 'YES or NO · website for {{business}}',
    body: `Let me make it easy.

Reply "YES" with your phone number if you want your website, or "NO" if it isn't for you.

{{site}}

Jose`,
  },
  {
    delay: 1,
    subject: 'Last email about your website',
    body: `This is my last email.

The sample website for {{business}} will stay online a little longer:

{{site}}

If you want it later, just reply "YES" with your phone number and I'll call you to finish it.

Thanks for taking a look.

Jose
Get ur Web`,
  },
];

// The HTML Instantly stores: a <div> per line and an empty <div> between paragraphs (same shape as the other campaigns)
export const toInstantlyHtml = (text) => text.split(/\n\s*\n/)
  .map(p => p.split('\n').map(line => `<div>${line}</div>`).join(''))
  .join('<div><br /></div>');

// The steps in the shape of the Instantly API. CAREFUL with the meaning of `delay` there: it is the wait AFTER that email, before
// the NEXT one is sent (not before it). Here `delay` of an email is "days to wait after the previous email", which reads better,
// so each step takes the delay of the email that FOLLOWS it (the last step has nothing after it: 0).
//   [email 1 (day 0), reminders with delays 2, 2, 3]  →  API delays [2, 2, 3, 0]  →  emails on days 0, 2, 4, 7
export const toSteps = (emails) => emails.map(({ subject, body }, i) => ({
  type: 'email', delay: emails[i + 1]?.delay ?? 0, delay_unit: 'days', variants: [{ subject, body: toInstantlyHtml(body), v_disabled: false }],
}));
