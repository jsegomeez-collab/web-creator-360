export function buildGenerationPrompt(business, webData, checkoutUrl) {
  const services = (webData.services || []).join(', ') || 'servicios profesionales';
  const images = (webData.raw_data?.images || []);
  const brandColor = webData.raw_data?.brandColor || null;
  const heroImage = images[0] || null;
  const galleryImages = images.slice(1, 5);

  const colorInstructions = brandColor
    ? `El color de marca principal extraído de su web es: ${brandColor}. Usa este color como base para el acento del halo y los gradientes.`
    : `Infiere un color de acento premium apropiado para un negocio del sector "${business.category}". Elige un color que transmita ${webData.tone || 'profesionalidad'}.`;

  const imageInstructions = heroImage
    ? `Imágenes reales del negocio disponibles:
- Hero/principal: ${heroImage}
${galleryImages.map((img, i) => `- Imagen ${i + 2}: ${img}`).join('\n')}
Úsalas en las secciones correspondientes mediante <img src="..."> con object-fit: cover.`
    : `El negocio no tiene imágenes disponibles. Usa fondos con gradientes CSS oscuros elegantes en lugar de imágenes.`;

  return `Eres un diseñador web de élite especializado en landing pages de alta conversión. Crea una web completa con el "Halo Theme" para el siguiente negocio local.

═══════════════════════════════════════
DATOS DEL NEGOCIO
═══════════════════════════════════════
Nombre: ${business.name}
Categoría: ${business.category}
Dirección: ${business.address || 'No disponible'}
Teléfono: ${business.phone || 'No disponible'}
Email: ${webData.email || 'No disponible'}
Web actual: ${business.website || 'Sin web'}
Descripción: ${webData.description}
Servicios: ${services}
Propuesta de valor: ${webData.value_proposition || 'Calidad y profesionalidad'}
Horario: ${webData.hours || 'Consultar'}
Idioma: ${webData.language || 'es'}
Tono: ${webData.tone || 'profesional'}

═══════════════════════════════════════
IDENTIDAD VISUAL — HALO THEME
═══════════════════════════════════════
${colorInstructions}

El Halo Theme usa:
- Fondo base: #050814 (negro profundo casi puro)
- Secciones con glassmorphism: background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.07);
- Halos de luz: radial-gradient con el color de acento al 15-20% de opacidad en esquinas/fondos de sección
- Texto principal: #F0F4FF (blanco suave)
- Texto secundario: #94A3B8 (gris plateado)
- CTAs: el color de acento como fondo sólido con box-shadow del mismo color
- Tipografía: Google Fonts → Playfair Display (títulos) + Inter (cuerpo). Cárgalas con <link>

${imageInstructions}

═══════════════════════════════════════
SECCIONES OBLIGATORIAS (en orden exacto)
═══════════════════════════════════════

1. HEADER STICKY
   - Logo/nombre a la izquierda (texto con gradiente del color de acento)
   - Nav desktop: Servicios | Sobre nosotros | Contacto (links ocultos en móvil con display:none / md:flex)
   - Botón CTA derecha: "Reservar / Contactar" (color acento, siempre visible)
   - background: rgba(5,8,20,0.85); backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 100;
   - MENÚ MÓVIL: botón hamburger que al hacer clic muestra panel desplegable con:
     * background: rgba(5,8,20,0.97); backdrop-filter: blur(30px); border-top: 1px solid rgba(255,255,255,0.07);
     * Cada link: padding 18px 24px, font-size 18px, color #F0F4FF, border-bottom 1px solid rgba(255,255,255,0.05)
     * Hover de cada link: color del acento + padding-left aumenta (efecto deslizante)
     * Al final del panel, botón CTA grande del color de acento con ancho completo
     * El panel se oculta/muestra con JS inline toggleando display:none / display:block
     * NUNCA uses estilos por defecto del navegador — todo inline o en <style>

2. HERO (altura mínima 100vh)
   - Si hay imagen: background con la imagen de hero al 30% opacidad encima de fondo oscuro
   - Si no hay imagen: gradiente oscuro con halo radial del color de acento
   - Badge superior pequeño: "⭐ ${business.rating ? business.rating + ' en Google' : 'El referente de ' + business.category}"
   - H1 impactante (máximo 8 palabras, en Playfair Display, grande)
   - Párrafo subtítulo (2 líneas máximo)
   - DOS botones CTA: primario ("Contactar ahora") + secundario outline ("Ver servicios")
   - Indicador scroll animado abajo

3. BARRA DE CONFIANZA (fondo ligeramente más claro)
   - 4 números/logros en fila: años de experiencia, clientes satisfechos, valoración, algo relevante al sector
   - Genera datos creíbles y coherentes con el negocio
   - Separados por líneas verticales sutiles

4. SERVICIOS
   - Título de sección con halo superior
   - Grid de tarjetas (2 o 3 columnas según cantidad de servicios)
   - Cada tarjeta: glassmorphism, emoji o icono SVG, nombre servicio, descripción breve (inventada pero coherente), precio si aplica
   - Hover: border del color de acento + halo suave

5. ¿POR QUÉ ELEGIRNOS? (sección con fondo alternativo oscuro)
   - 3 columnas con iconos SVG grandes
   - Puntos fuertes del negocio extraídos de la propuesta de valor

6. SOBRE NOSOTROS / HISTORIA
   - Layout dos columnas: texto izquierda, imagen derecha (si hay imagen disponible)
   - Historia/descripción elaborada del negocio
   - Pequeña cita o frase destacada del negocio en grande con comillas tipográficas

7. GALERÍA (solo si hay 3+ imágenes disponibles, si no omitir)
   - Grid masonry de imágenes reales
   - Hover con overlay de color acento semitransparente

8. TESTIMONIOS
   - 3 tarjetas glassmorphism con testimonio inventado pero realista
   - Nombre, cargo/perfil, ⭐⭐⭐⭐⭐
   - Genera nombres y perfiles coherentes con el idioma y zona del negocio

9. PREGUNTAS FRECUENTES (FAQ)
   - 4 preguntas con acordeón CSS puro (sin JS externo)
   - Preguntas coherentes con el sector del negocio
   - Respuestas con información del negocio

10. CONTACTO / CTA FINAL
    - Fondo con halo radial grande del color de acento
    - Título urgente: "¿Listo para [acción relevante]?"
    - Datos de contacto: teléfono clicable (tel:), email clicable (mailto:), dirección
    - Horario
    - Botón grande CTA principal

11. FOOTER
    - Nombre negocio + descripción una línea
    - Links: Servicios, Contacto, Política de privacidad
    - Redes sociales (iconos SVG si hay datos, si no omitir)
    - Copyright año actual

═══════════════════════════════════════
ELEMENTOS FLOTANTES
═══════════════════════════════════════
A. Botón WhatsApp (esquina inferior izquierda):
   <a href="https://wa.me/${(business.phone || '').replace(/[^0-9]/g, '')}" target="_blank" style="position:fixed;bottom:24px;left:24px;z-index:9999;width:52px;height:52px;background:#25D366;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(37,211,102,0.4);text-decoration:none;">
     [icono WhatsApp SVG blanco]
   </a>

B. Botón "Activar mi web" (esquina inferior derecha) — enlaza a WhatsApp para contacto cálido:
   <a href="https://wa.me/34672577986?text=Buenas%20Jose%2C%20me%20gustar%C3%ADa%20activar%20la%20web%20que%20me%20enviaste%20en%20mi%20dominio%20personalizado!" target="_blank" style="position:fixed;bottom:24px;right:24px;z-index:9999;background:[COLOR_ACENTO];color:white;font-family:Inter,sans-serif;font-size:13px;font-weight:700;padding:12px 20px;border-radius:50px;box-shadow:0 4px 20px rgba([RGB_ACENTO],0.5);text-decoration:none;display:flex;align-items:center;gap:8px;">
     ✦ Activar mi web · $497
   </a>

C. Selector de idioma EN/ES (esquina superior derecha, fixed, encima del header):
   Incluye SIEMPRE este bloque exacto justo antes del </body>:

   <div id="lang-switcher" style="position:fixed;top:16px;right:20px;z-index:10000;display:flex;gap:4px;background:rgba(5,8,20,0.85);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:4px;font-family:Inter,sans-serif;">
     <button id="btn-es" onclick="setLang('es')" style="background:transparent;border:none;color:#F0F4FF;font-size:12px;font-weight:700;padding:5px 10px;border-radius:5px;cursor:pointer;letter-spacing:.05em;transition:background .15s;">ES</button>
     <button id="btn-en" onclick="setLang('en')" style="background:transparent;border:none;color:#F0F4FF;font-size:12px;font-weight:700;padding:5px 10px;border-radius:5px;cursor:pointer;letter-spacing:.05em;transition:background .15s;">EN</button>
   </div>
   <script>
   (function(){
     var LANG={};
     // Rellena LANG con todas las cadenas de texto de la web en ambos idiomas
     // Formato: LANG['es']={key:'texto español',...}  LANG['en']={key:'texto inglés',...}
     // Cada elemento traducible lleva data-t="key"
     function setLang(l){
       document.querySelectorAll('[data-t]').forEach(function(el){
         if(LANG[l]&&LANG[l][el.dataset.t]) el.textContent=LANG[l][el.dataset.t];
       });
       var btns={es:document.getElementById('btn-es'),en:document.getElementById('btn-en')};
       Object.keys(btns).forEach(function(k){if(btns[k])btns[k].style.background=k===l?'rgba(99,102,241,.6)':'transparent';});
       localStorage.setItem('wc360lang',l);
     }
     window.setLang=setLang;
     setLang(localStorage.getItem('wc360lang')||'${webData.language || 'es'}');
   })();
   </script>

   INSTRUCCIÓN CRÍTICA para el selector de idioma:
   - Añade data-t="key" a TODOS los textos visibles de la web (títulos, subtítulos, botones, párrafos, items de servicios, testimonios, FAQ preguntas y respuestas, footer, etc.)
   - Define el objeto LANG completo con las traducciones ES y EN de cada key antes de la función setLang
   - El idioma inicial por defecto es: ${webData.language || 'es'}
   - Los botones del switcher deben resaltar visualmente el idioma activo

═══════════════════════════════════════
REQUISITOS TÉCNICOS
═══════════════════════════════════════
- CRÍTICO: El contenido debe ser SIEMPRE VISIBLE. Nunca uses opacity:0 sin una animación CSS automática que lo resuelva. Si usas fade-in, asegúrate de que el keyframe lo lleva a opacity:1 sin necesitar JavaScript.
- Devuelve ÚNICAMENTE el HTML completo empezando por <!DOCTYPE html>. Sin markdown, sin explicaciones.
- Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
- Google Fonts via <link>: Playfair Display + Inter
- Todo el CSS personalizado del Halo Theme en un <style> en el <head>
- Acordeón FAQ con CSS puro (checkbox hack o <details>/<summary>)
- Smooth scroll: <html style="scroll-behavior:smooth">
- Meta tags: title, description, og:title, og:description, og:image (si hay imagen)
- Totalmente responsive. Mobile-first.
- Animaciones: NUNCA uses opacity:0 + IntersectionObserver. Usa SOLO @keyframes CSS con animation-fill-mode:both para que el contenido sea siempre visible. Ejemplo: @keyframes fadeUp { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:none} } .fade-in{animation:fadeUp 0.6s ease both}
- El idioma de TODO el contenido debe ser: ${webData.language || 'es'}

Escribe el HTML completo ahora:`;
}
