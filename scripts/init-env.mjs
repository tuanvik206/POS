import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
if (existsSync(file)) {
  console.log('.env đã tồn tại; giữ nguyên để tránh ghi đè mật khẩu hiện tại.');
  process.exit(0);
}

const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');
const adminPassword = `Pos-${secret(12)}!`;
const values = [
  'COMPOSE_PROJECT_NAME=pos-store',
  'APP_PORT=8080',
  'MYSQL_DATABASE=pos_store',
  'MYSQL_USER=pos_app',
  `MYSQL_PASSWORD=${secret()}`,
  `MYSQL_ROOT_PASSWORD=${secret()}`,
  `MYSQL_EXPORTER_PASSWORD=${secret()}`,
  `JWT_SECRET=${secret(48)}`,
  'ADMIN_USERNAME=admin',
  `ADMIN_PASSWORD=${adminPassword}`,
  'GRAFANA_ADMIN_USER=admin',
  `GRAFANA_ADMIN_PASSWORD=${secret(18)}`,
  'TZ=Asia/Ho_Chi_Minh',
];
writeFileSync(file, `${values.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
console.log('Đã tạo .env với các mật khẩu ngẫu nhiên.');
console.log(`Tài khoản quản trị ứng dụng: admin / ${adminPassword}`);
console.log('Mật khẩu Grafana và MySQL được lưu trong .env. Hãy giữ file này riêng tư.');
