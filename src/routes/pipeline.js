import { Router } from 'express';
import { runAutoPipeline } from '../pipeline/auto.js';

const router = Router();

// Manual trigger — streams NDJSON progress like the regenerate batch endpoint
router.post('/run', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();

  res.write(JSON.stringify({ status: 'starting', message: 'Pipeline iniciado...' }) + '\n');

  try {
    const result = await runAutoPipeline();

    if (result.skipped) {
      res.write(JSON.stringify({ status: 'skipped', message: 'Ya hay un pipeline en ejecución' }) + '\n');
    } else {
      for (const entry of result.log || []) {
        res.write(JSON.stringify(entry) + '\n');
      }
      res.write(JSON.stringify({
        status: 'done',
        scraped: result.scraped,
        generated: result.generated,
        sent: result.sent,
        errors: result.errors,
        skipped_no_email: result.skipped_no_email,
      }) + '\n');
    }
  } catch (err) {
    res.write(JSON.stringify({ status: 'error', message: err.message }) + '\n');
  }

  res.end();
});

export default router;
