import { Resend } from 'resend';

let resend;

function getClient() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

const FOLLOW_UP_INTERVALS = [5, 5]; // days after each follow-up

export async function sendOutreachEmail(business, site, followUpNumber = 0, language = 'es') {
  const isFollowUp = followUpNumber > 0;
  const isEn = language === 'en';
  const subject = isFollowUp
    ? (isEn ? `Hey, the website we built for ${business.name} is still waiting` : `Oye, tu web de ${business.name} sigue ahí esperándote`)
    : (isEn ? `${business.name}, we built you a website — take a look` : `${business.name}, te hemos creado una web — mírala`);

  const html = buildEmailHtml(business, site, isFollowUp, language);

  await getClient().emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: site.contact_email || business.email,
    subject,
    html,
  });
}

const WA_LINKS = {
  es: 'https://wa.me/34672577986?text=Buenas%20Jose%2C%20me%20gustar%C3%ADa%20activar%20la%20web%20que%20me%20enviaste%20en%20mi%20dominio%20personalizado!',
  en: 'https://wa.me/34672577986?text=Hi%20Jose%2C%20I%27d%20like%20to%20activate%20the%20website%20you%20sent%20me%20on%20my%20own%20domain!',
};

const COPY = {
  es: {
    intro: (name, isFollowUp) => isFollowUp
      ? `Hace unos días te enviamos la web que creamos para <strong>${name}</strong>. Por si no pudiste verla, aquí te la dejamos de nuevo.`
      : `Le hemos echado un ojo a <strong>${name}</strong> y hemos creado una web nueva desde cero, pensada para tu negocio. Ya está publicada y puedes verla ahora mismo.`,
    body: 'No es una maqueta ni una plantilla genérica. Es una web completa, con tu nombre, tus servicios y tu imagen de marca — lista para activarse en tu dominio.',
    previewBtn: '👀 Ver mi web',
    priceLabel: '¿Te gusta? Actívala por',
    price: '347€',
    priceDetail: 'Incluye activación en tu dominio, hosting 1 año y soporte de puesta en marcha. Sin sorpresas.',
    customNote: null,
    waBtn: 'Hablar por WhatsApp',
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
    waBtn: 'Chat on WhatsApp',
    footer: "We reply in minutes. If you have any questions about the site or want tweaks before going live, just write to us.",
    expiry: 'This preview will be available for 15 days',
    headerSub: 'Web Creator 360',
    headerTitle: 'Your website is ready',
  },
};

function buildEmailHtml(business, site, isFollowUp, language = 'es') {
  const lang = language === 'en' ? 'en' : 'es';
  const t = COPY[lang];
  const WA_LINK = WA_LINKS[lang];
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

      <!-- Price + WA block -->
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:24px;text-align:center;margin:28px 0;">
        <p style="margin:0 0 6px;font-size:13px;color:#15803d;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${t.priceLabel}</p>
        <p style="margin:0 0 16px;font-size:40px;font-weight:800;color:#14532d;line-height:1;">${t.price}</p>
        <p style="margin:0 0 ${t.customNote ? '12px' : '18px'};font-size:14px;color:#374151;line-height:1.6;">${t.priceDetail}</p>
        ${t.customNote ? `<p style="margin:0 0 18px;font-size:13px;color:#15803d;font-style:italic;line-height:1.5;">${t.customNote}</p>` : ''}
        <a href="${WA_LINK}" target="_blank"
           style="display:inline-flex;align-items:center;gap:10px;background:#25D366;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.117.549 4.107 1.51 5.845L.057 23.5l5.797-1.522A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.006-1.374l-.359-.213-3.44.903.92-3.353-.233-.373A9.818 9.818 0 1112 21.818z"/></svg>
          ${t.waBtn}
        </a>
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
