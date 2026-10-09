import { Router } from 'express';
import { inTransaction } from '../db.js';
import { exportData, restoreData } from '../services/backup.js';

// Thrown to roll back a preview: the merge runs for real, then is undone.
class PreviewOnly extends Error {}

export function createBackupRouter(db) {
  const router = Router();

  router.get('/', (req, res) => res.json(exportData(db, req.userId)));

  router.post('/restore', (req, res) => {
    const preview = req.query.dryRun === '1';
    let summary;
    try {
      inTransaction(db, () => {
        summary = restoreData(db, req.userId, req.body);
        if (preview) throw new PreviewOnly();
      });
    } catch (err) {
      if (!(err instanceof PreviewOnly)) throw err;
    }
    res.json({ preview, summary });
  });

  return router;
}
