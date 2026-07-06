import { Router } from 'express';
import supabase from '../db/supabase.js';

const router = Router();

router.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  const { data: site, error } = await supabase
    .from('generated_sites')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !site) {
    return res.status(404).send(errorPage('404', 'Preview no encontrada', 'Esta URL no existe o ya fue eliminada.'));
  }

  if (site.status === 'expired') {
    return res.status(410).send(errorPage('410', 'Preview expirada', 'Esta preview ya no está disponible. Contacta con nosotros si estás interesado.'));
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(site.html_content);
});

function errorPage(code, title, message) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${code} — ${title}</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen flex items-center justify-center bg-gray-50">
  <div class="text-center p-8">
    <p class="text-6xl font-bold text-gray-300 mb-4">${code}</p>
    <h1 class="text-2xl font-semibold text-gray-800 mb-2">${title}</h1>
    <p class="text-gray-500">${message}</p>
  </div>
</body>
</html>`;
}

export default router;
