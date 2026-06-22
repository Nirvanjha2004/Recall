import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { config } from '../config';
import { Decision } from '../types';

export const apiRouter = Router();

/**
 * Middleware: Verify Admin Access
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization token required.' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid authentication header format.' });
  }

  const token = parts[1];
  if (token !== config.adminPassword) {
    return res.status(403).json({ error: 'Invalid admin password.' });
  }

  next();
}

/**
 * Route: Admin Auth verification
 */
apiRouter.post('/auth', (req: Request, res: Response) => {
  const { password } = req.body;
  if (password === config.adminPassword) {
    return res.json({ success: true, token: config.adminPassword });
  }
  return res.status(401).json({ success: false, error: 'Incorrect password.' });
});

/**
 * Route: Fetch decisions with filtering
 */
apiRouter.get('/decisions', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { category, search, limit = 50, offset = 0 } = req.query;
    
    let queryText = 'SELECT * FROM decisions WHERE 1=1';
    const queryParams: any[] = [];
    let paramCounter = 1;

    if (category) {
      queryText += ` AND category = $${paramCounter}`;
      queryParams.push(category);
      paramCounter++;
    }

    if (search) {
      queryText += ` AND (decision_text ILIKE $${paramCounter} OR rationale ILIKE $${paramCounter} OR user_name ILIKE $${paramCounter} OR channel_name ILIKE $${paramCounter})`;
      queryParams.push(`%${search}%`);
      paramCounter++;
    }

    queryText += ` ORDER BY message_date DESC LIMIT $${paramCounter} OFFSET $${paramCounter + 1}`;
    queryParams.push(parseInt(limit as string, 10));
    queryParams.push(parseInt(offset as string, 10));

    const result = await db.query<Decision>(queryText, queryParams);
    return res.json(result.rows);
  } catch (error) {
    console.error('Error fetching decisions:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Route: Fetch stats & analytics
 */
apiRouter.get('/stats', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    // 1. Total count
    const totalCountRes = await db.query('SELECT COUNT(*) as count FROM decisions');
    const totalCount = parseInt(totalCountRes.rows[0].count, 10);

    // 2. Count by category
    const categoryCountRes = await db.query(
      'SELECT category, COUNT(*) as count FROM decisions GROUP BY category'
    );
    const categoryBreakdown = categoryCountRes.rows.reduce((acc: any, row: any) => {
      acc[row.category] = parseInt(row.count, 10);
      return acc;
    }, { decision: 0, commitment: 0, resolved_question: 0 });

    // 3. Active channels count
    const activeChannelsRes = await db.query('SELECT COUNT(DISTINCT channel_id) as count FROM decisions');
    const activeChannels = parseInt(activeChannelsRes.rows[0].count, 10);

    // 4. Workspaces count
    const workspaceCountRes = await db.query('SELECT COUNT(*) as count FROM workspaces');
    const totalWorkspaces = parseInt(workspaceCountRes.rows[0].count, 10);

    // 5. List of installed workspaces
    const workspacesRes = await db.query('SELECT team_id, team_name, created_at FROM workspaces ORDER BY created_at DESC');

    return res.json({
      totalCount,
      categoryBreakdown,
      activeChannels,
      totalWorkspaces,
      workspaces: workspacesRes.rows
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Route: Delete a decision (moderation)
 */
apiRouter.delete('/decisions/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM decisions WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Decision not found.' });
    }
    
    return res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('Error deleting decision:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
