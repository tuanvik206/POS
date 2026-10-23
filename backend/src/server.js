import express from 'express';
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { initializeDatabase, pool } from './db.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
const app = express();
const registry = new Registry();

function writeLog(level, message, details = {}) {
  const entry = { level, message, ...details, time: new Date().toISOString() };
  const line = `${JSON.stringify(entry)}\n`;
  console[level === 'error' ? 'error' : 'log'](line.trimEnd());
  appendFile('/var/log/pos/api.jsonl', line, 'utf8').catch(() => {});
}

collectDefaultMetrics({ register: registry });
const requests = new Counter({ name: 'http_requests_total', help: 'Total HTTP requests', labelNames: ['method', 'route', 'status'], registers: [registry] });
const duration = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP request duration in seconds', labelNames: ['method', 'route', 'status'], registers: [registry], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5] });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  const end = duration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
    requests.inc({ method: req.method, route, status: String(res.statusCode) });
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const tokenSecret = process.env.JWT_SECRET;

function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
  try { req.user = jwt.verify(token, tokenSecret, { algorithms: ['HS256'], issuer: 'pos-store' }); next(); }
  catch { return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn.' }); }
}
const adminOnly = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Chỉ quản trị viên được thực hiện thao tác này.' });

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'pos-api' });
}));
app.get('/metrics', asyncRoute(async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}));

app.post('/api/v1/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const parsed = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Tên đăng nhập hoặc mật khẩu không hợp lệ.' });
  const [rows] = await pool.execute('SELECT id, username, password_hash, display_name, role FROM users WHERE username=? AND active=1', [parsed.data.username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  const token = jwt.sign({ sub: user.id, username: user.username, name: user.display_name, role: user.role }, tokenSecret, { algorithm: 'HS256', expiresIn: '8h', issuer: 'pos-store' });
  res.json({ token, user: { id: user.id, username: user.username, name: user.display_name, role: user.role } });
}));

app.post('/api/v1/users', auth, adminOnly, asyncRoute(async (req, res) => {
  const parsed = z.object({ username: z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._-]+$/), password: z.string().min(12).max(200), name: z.string().trim().min(1).max(120), role: z.enum(['admin','cashier']).default('cashier') }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Thông tin tài khoản không hợp lệ. Mật khẩu cần tối thiểu 12 ký tự.' });
  const { username, password, name, role } = parsed.data;
  try {
    const [result] = await pool.execute('INSERT INTO users(username,password_hash,display_name,role) VALUES(?,?,?,?)', [username, await bcrypt.hash(password, 12), name, role]);
    res.status(201).json({ id: result.insertId, username, name, role });
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' }); throw error; }
}));

app.get('/api/v1/dashboard', auth, asyncRoute(async (_req, res) => {
  const [[totals]] = await pool.query(`SELECT COUNT(*) AS product_count,
    COALESCE(SUM(stock),0) AS unit_count,
    COALESCE(SUM(CASE WHEN stock <= reorder_level THEN 1 ELSE 0 END),0) AS low_stock_count
    FROM products WHERE active=1`);
  const [[today]] = await pool.query(`SELECT COUNT(*) AS sale_count, COALESCE(SUM(total),0) AS revenue
    FROM sales WHERE DATE(created_at)=CURRENT_DATE()`);
  const [recent] = await pool.query(`SELECT s.id,s.receipt_no,s.total,s.payment_method,s.created_at,u.display_name AS cashier
    FROM sales s JOIN users u ON u.id=s.cashier_id ORDER BY s.id DESC LIMIT 8`);
  res.json({ ...totals, ...today, recent });
}));

app.get('/api/v1/products', auth, asyncRoute(async (req, res) => {
  const search = `%${String(req.query.search || '').slice(0, 80)}%`;
  const [rows] = await pool.execute(`SELECT p.id,p.sku,p.name,p.category_id,p.price,p.stock,p.reorder_level,p.active,c.name AS category
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.active=1 AND (p.name LIKE ? OR p.sku LIKE ?) ORDER BY p.name LIMIT 500`, [search, search]);
  res.json(rows);
}));

const productInput = z.object({ sku: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(180), category_id: z.number().int().positive().nullable().optional(), price: z.number().int().nonnegative().max(999_999_999_999), stock: z.number().int().nonnegative().max(4_294_967_295).optional(), reorder_level: z.number().int().nonnegative().max(4_294_967_295).optional() }).strict();
app.post('/api/v1/products', auth, adminOnly, asyncRoute(async (req, res) => {
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dữ liệu sản phẩm không hợp lệ.' });
  const p = parsed.data;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute('INSERT INTO products(sku,name,category_id,price,stock,reorder_level) VALUES(?,?,?,?,?,?)', [p.sku, p.name, p.category_id ?? null, p.price, p.stock ?? 0, p.reorder_level ?? 5]);
    if ((p.stock ?? 0) > 0) await conn.execute('INSERT INTO stock_movements(product_id,user_id,change_qty,reason) VALUES(?,?,?,?)', [result.insertId, req.user.sub, p.stock, 'restock']);
    await conn.commit();
    res.status(201).json({ id: result.insertId, ...p });
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Mã SKU đã tồn tại.' });
    throw error;
  } finally { conn.release(); }
}));
app.patch('/api/v1/products/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const parsed = productInput.omit({ stock: true }).partial().strict().safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data || {}).length === 0) return res.status(400).json({ error: 'Không có dữ liệu cập nhật hợp lệ.' });
  const fields = parsed.data;
  const columns = { sku: 'sku', name: 'name', category_id: 'category_id', price: 'price', reorder_level: 'reorder_level' };
  const assignments = Object.keys(fields).filter((key) => columns[key]).map((key) => `${columns[key]}=?`);
  if (!assignments.length) return res.status(400).json({ error: 'Không có trường cập nhật hợp lệ.' });
  try {
    const [result] = await pool.execute(`UPDATE products SET ${assignments.join(',')} WHERE id=? AND active=1`, [...Object.keys(fields).filter((key) => columns[key]).map((key) => fields[key]), req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
    res.json({ ok: true });
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Mã SKU đã tồn tại.' }); throw error; }
}));
app.post('/api/v1/inventory/adjust', auth, adminOnly, asyncRoute(async (req, res) => {
  const parsed = z.object({ product_id: z.number().int().positive(), change_qty: z.number().int().min(-4_294_967_295).max(4_294_967_295).refine((n) => n !== 0), reason: z.enum(['restock','correction']) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Số lượng điều chỉnh không hợp lệ.' });
  const { product_id, change_qty, reason } = parsed.data;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT stock FROM products WHERE id=? AND active=1 FOR UPDATE', [product_id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' }); }
    const nextStock = rows[0].stock + change_qty;
    if (nextStock < 0) { await conn.rollback(); return res.status(409).json({ error: 'Tồn kho không đủ để giảm số lượng.' }); }
    if (nextStock > 4_294_967_295) { await conn.rollback(); return res.status(409).json({ error: 'Số lượng vượt giới hạn tồn kho.' }); }
    await conn.execute('UPDATE products SET stock=stock+? WHERE id=?', [change_qty, product_id]);
    await conn.execute('INSERT INTO stock_movements(product_id,user_id,change_qty,reason) VALUES(?,?,?,?)', [product_id, req.user.sub, change_qty, reason]);
    await conn.commit();
    res.json({ ok: true, stock: nextStock });
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}));

app.get('/api/v1/orders', auth, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query(`SELECT s.id,s.receipt_no,s.subtotal,s.discount,s.total,s.payment_method,s.created_at,u.display_name AS cashier
    FROM sales s JOIN users u ON u.id=s.cashier_id ORDER BY s.id DESC LIMIT 100`);
  res.json(rows);
}));
app.get('/api/v1/orders/:id', auth, asyncRoute(async (req, res) => {
  const [[sale]] = await pool.execute(`SELECT s.*,u.display_name AS cashier FROM sales s JOIN users u ON u.id=s.cashier_id WHERE s.id=?`, [req.params.id]);
  if (!sale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn.' });
  const [items] = await pool.execute('SELECT product_name,sku,quantity,unit_price,line_total FROM sale_items WHERE sale_id=?', [sale.id]);
  res.json({ ...sale, items });
}));
app.post('/api/v1/checkout', auth, asyncRoute(async (req, res) => {
  const parsed = z.object({ items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().positive().max(99) })).min(1).max(50), discount: z.number().nonnegative().max(0).default(0), payment_method: z.enum(['cash','card','transfer']) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Thông tin thanh toán không hợp lệ.' });
  const merged = new Map();
  for (const item of parsed.data.items) {
    const quantity = (merged.get(item.product_id) || 0) + item.quantity;
    if (quantity > 99) return res.status(400).json({ error: 'Mỗi sản phẩm không được vượt quá 99 đơn vị trong một hóa đơn.' });
    merged.set(item.product_id, quantity);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const items = [];
    for (const id of [...merged.keys()].sort((a, b) => a - b)) {
      const quantity = merged.get(id);
      const [rows] = await conn.execute('SELECT id,sku,name,price,stock FROM products WHERE id=? AND active=1 FOR UPDATE', [id]);
      const product = rows[0];
      if (!product) { const error = new Error('Một sản phẩm không còn khả dụng.'); error.status = 409; throw error; }
      if (product.stock < quantity) { const error = new Error(`Tồn kho ${product.name} không đủ.`); error.status = 409; throw error; }
      items.push({ ...product, quantity, line_total: Math.round(product.price * quantity * 100) / 100 });
    }
    const subtotal = Math.round(items.reduce((sum, item) => sum + item.line_total, 0) * 100) / 100;
    const discount = Math.min(parsed.data.discount, subtotal);
    const total = Math.round((subtotal - discount) * 100) / 100;
    const receiptNo = `POS-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
    const [sale] = await conn.execute('INSERT INTO sales(receipt_no,cashier_id,subtotal,discount,total,payment_method) VALUES(?,?,?,?,?,?)', [receiptNo, req.user.sub, subtotal, discount, total, parsed.data.payment_method]);
    for (const item of items) {
      await conn.execute('INSERT INTO sale_items(sale_id,product_id,product_name,sku,quantity,unit_price,line_total) VALUES(?,?,?,?,?,?,?)', [sale.insertId,item.id,item.name,item.sku,item.quantity,item.price,item.line_total]);
      await conn.execute('UPDATE products SET stock=stock-? WHERE id=?', [item.quantity,item.id]);
      await conn.execute('INSERT INTO stock_movements(product_id,user_id,change_qty,reason,reference) VALUES(?,?,?,?,?)', [item.id,req.user.sub,-item.quantity,'sale',receiptNo]);
    }
    await conn.commit();
    res.status(201).json({ id: sale.insertId, receipt_no: receiptNo, subtotal, discount, total, payment_method: parsed.data.payment_method, items });
  } catch (error) { await conn.rollback(); if (error.status) return res.status(error.status).json({ error: error.message }); throw error; } finally { conn.release(); }
}));

app.use((_req, res) => res.status(404).json({ error: 'Không tìm thấy API.' }));
app.use((error, _req, res, _next) => {
  writeLog('error', error.message, { code: error.code });
  res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
});

const port = Number(process.env.PORT || 3000);
await initializeDatabase();
app.listen(port, '0.0.0.0', () => writeLog('info', 'POS API started', { port }));
