export function buildScrapingPrompt(business, foundEmails = []) {
  const emailHint = foundEmails.length
    ? `\nEmails encontrados automáticamente en su web: ${foundEmails.slice(0, 3).join(', ')} → usa el primero como "email".`
    : '';

  return `Eres un asistente experto en análisis de negocios locales. Tu tarea es investigar el siguiente negocio y devolver un perfil estructurado en JSON.

Negocio:
- Nombre: ${business.name}
- Dirección: ${business.address}
- Teléfono: ${business.phone || 'No disponible'}
- Web actual: ${business.website || 'Sin web'}
- Categoría: ${business.category}
- Valoración Google: ${business.rating || 'Sin valoración'}${emailHint}

Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta (sin markdown, sin texto adicional):
{
  "description": "Descripción breve y atractiva del negocio (2-3 frases)",
  "services": ["servicio1", "servicio2", "servicio3"],
  "value_proposition": "Qué hace diferente a este negocio de la competencia",
  "hours": "Horario de apertura si está disponible o null",
  "language": "es o ca o en según el idioma predominante del negocio",
  "email": "email de contacto si está disponible o null",
  "social_networks": [{"platform": "instagram", "url": "https://..."}],
  "tone": "profesional | cercano | moderno | tradicional | premium"
}`;
}
