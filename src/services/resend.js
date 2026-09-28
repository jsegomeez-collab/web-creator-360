import { Resend } from 'resend';

let resend;

function getClient() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

// The SDK returns API failures as { error } instead of throwing — surface them so a rejected send is never counted as sent
async function send(payload) {
  const { error } = await getClient().emails.send(payload);
  if (error) throw new Error(`Resend: ${error.message || error.name || 'error al enviar el email'}`);
}

const FOLLOW_UP_INTERVALS = [5, 5]; // days after each follow-up

export async function sendOutreachEmail(business, site, followUpNumber = 0, language = 'es') {
  const isFollowUp = followUpNumber > 0;
  const isEn = language === 'en';
  const subject = isFollowUp
    ? (isEn ? `Hey, the website we built for ${business.name} is still waiting` : `Oye, tu web de ${business.name} sigue ahí esperándote`)
    : (isEn ? `${business.name}, we built you a website — take a look` : `${business.name}, te hemos creado una web — mírala`);

  const html = buildEmailHtml(business, site, isFollowUp, language);

  await send({
    from: process.env.RESEND_FROM_EMAIL,
    to: site.contact_email || business.email,
    subject,
    html,
  });
}

// Booking link of the call the emails invite to (optional: without it the email simply has no call button)
const calendarUrl = () => (process.env.CALENDAR_URL || '').trim();

const COPY = {
  es: {
    intro: (name, isFollowUp) => isFollowUp
      ? `Hace unos días te enviamos la web que creamos para <strong>${name}</strong>. Por si no pudiste verla, aquí te la dejamos de nuevo.`
      : `Le hemos echado un ojo a <strong>${name}</strong> y hemos creado una web nueva desde cero, pensada para tu negocio. Ya está publicada y puedes verla ahora mismo.`,
    body: 'No es una maqueta ni una plantilla genérica. Es una web completa, con tu nombre, tus servicios y tu imagen de marca — lista para activarse en tu dominio.',
    previewBtn: '👀 Ver mi web',
    priceLabel: '¿Te gusta? Actívala por',
    price: '$497',
    priceDetail: 'Incluye activación en tu dominio, hosting 1 año y soporte de puesta en marcha. Sin sorpresas.',
    customNote: 'Esto es solo un ejemplo — podemos hacer los cambios que necesites para que quede 100% a tu gusto antes de activarla.',
    callBtn: '📞 Agenda una llamada de 15 minutos',
    footer: 'Respondemos en minutos. Si tienes cualquier duda sobre la web o quieres hacer algún ajuste antes de activar, también puedes escribirnos.',
    expiry: 'Esta preview estará disponible 15 días',
    headerSub: 'Web Creator 360',
    headerTitle: 'Tu web ya está lista',
  },
  en: {
    intro: (name, isFollowUp) => isFollowUp
      ? `A few days ago we sent you the website we built for <strong>${name}</strong>. In case you missed it, here it is again.`
      : `We took a look at <strong>${name}</strong> and built a brand new website from scratch, tailored to your business. It's already live — take a look.`,
    body: "It's not a mockup or a generic template. It's a complete website with your name, your services and your brand — ready to go live on your domain.",
    previewBtn: '👀 View my website',
    priceLabel: 'Like it? Activate it for',
    price: '$497',
    priceDetail: 'Includes domain activation, 1 year hosting and onboarding support. No hidden fees.',
    customNote: 'This is just an example — we can make any changes you need so the site is 100% tailored to your taste before going live. Just send us a message.',
    callBtn: '📞 Book a 15-minute call',
    footer: "We reply in minutes. If you have any questions about the site or want tweaks before going live, just write to us.",
    expiry: 'This preview will be available for 15 days',
    headerSub: 'Web Creator 360',
    headerTitle: 'Your website is ready',
  },
};

function buildEmailHtml(business, site, isFollowUp, language = 'es') {
  const lang = language === 'en' ? 'en' : 'es';
  const t = COPY[lang];
  const CALENDAR = calendarUrl();
  const introParagraph = t.intro(business.name, isFollowUp);

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#050814;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#94A3B8;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">${t.headerSub}</p>
      <h1 style="margin:10px 0 0;color:#F0F4FF;font-size:24px;font-weight:700;line-height:1.3;">${t.headerTitle}</h1>
    </div>

    <!-- Body -->
    <div style="padding:32px;">
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">${introParagraph}</p>
      <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.7;">${t.body}</p>

      <!-- Preview CTA -->
      <div style="text-align:center;margin:28px 0;">
        <a href="${site.preview_url}" target="_blank"
           style="display:inline-block;background:#050814;color:#ffffff;text-decoration:none;padding:15px 32px;border-radius:8px;font-weight:700;font-size:16px;letter-spacing:0.3px;">
          ${t.previewBtn}
        </a>
      </div>

      <!-- Price + call block -->
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:24px;text-align:center;margin:28px 0;">
        <p style="margin:0 0 6px;font-size:13px;color:#15803d;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${t.priceLabel}</p>
        <p style="margin:0 0 16px;font-size:40px;font-weight:800;color:#14532d;line-height:1;">${t.price}</p>
        <p style="margin:0 0 ${t.customNote ? '12px' : '18px'};font-size:14px;color:#374151;line-height:1.6;">${t.priceDetail}</p>
        ${t.customNote ? `<p style="margin:0 0 18px;font-size:13px;color:#15803d;font-style:italic;line-height:1.5;">${t.customNote}</p>` : ''}
        ${CALENDAR ? `<a href="${CALENDAR}" target="_blank"
           style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px;">
          ${t.callBtn}
        </a>` : ''}
      </div>

      <p style="margin:0;font-size:13px;color:#9ca3af;line-height:1.6;">${t.footer}</p>
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;border-top:1px solid #f3f4f6;padding:20px 32px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">${t.expiry} · <a href="${site.preview_url}" style="color:#6b7280;">${site.preview_url}</a></p>
    </div>
  </div>
</body>
</html>`;
}

export function nextFollowUpDate(followUpNumber) {
  const days = FOLLOW_UP_INTERVALS[followUpNumber] || null;
  if (!days) return null;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}
