import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: 10,
  waitForConnections: true,
  timezone: '+07:00',
  decimalNumbers: true,
});

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(80) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    role ENUM('admin','cashier') NOT NULL DEFAULT 'cashier',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS categories (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(180) NOT NULL,
    category_id BIGINT UNSIGNED NULL,
    price DECIMAL(14,2) NOT NULL,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    reorder_level INT UNSIGNED NOT NULL DEFAULT 5,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    INDEX idx_products_name (name), INDEX idx_products_stock (stock)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sales (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    receipt_no VARCHAR(32) NOT NULL UNIQUE,
    cashier_id BIGINT UNSIGNED NOT NULL,
    subtotal DECIMAL(14,2) NOT NULL,
    discount DECIMAL(14,2) NOT NULL DEFAULT 0,
    total DECIMAL(14,2) NOT NULL,
    payment_method ENUM('cash','card','transfer') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sales_cashier FOREIGN KEY (cashier_id) REFERENCES users(id),
    INDEX idx_sales_created (created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sale_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sale_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name VARCHAR(180) NOT NULL,
    sku VARCHAR(64) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(14,2) NOT NULL,
    line_total DECIMAL(14,2) NOT NULL,
    CONSTRAINT fk_items_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id),
    INDEX idx_items_product (product_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS stock_movements (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    change_qty INT NOT NULL,
    reason ENUM('restock','sale','correction') NOT NULL,
    reference VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_movement_product FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT fk_movement_user FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_movement_created (created_at)
  ) ENGINE=InnoDB`,
];

export async function initializeDatabase() {
  for (const statement of schema) await pool.query(statement);
  await pool.query("INSERT IGNORE INTO categories(name) VALUES ('Chưa phân loại')");
  await pool.query("INSERT IGNORE INTO categories(name) VALUES ('Đồ uống'),('Thực phẩm'),('Gia dụng')");

  const [rows] = await pool.query('SELECT id FROM users LIMIT 1');
  if (rows.length === 0) {
    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    if (!username || !password || password.length < 12) {
      throw new Error('ADMIN_USERNAME and a 12+ character ADMIN_PASSWORD are required for first setup');
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.execute(
      'INSERT INTO users(username,password_hash,display_name,role) VALUES(?,?,?,?)',
      [username, hash, 'Quản trị viên', 'admin'],
    );
  }

  const [[products]] = await pool.query('SELECT COUNT(*) AS count FROM products');
  if (products.count === 0) {
    await pool.query(`INSERT INTO products(sku,name,category_id,price,stock,reorder_level)
      SELECT samples.sku,samples.name,categories.id,samples.price,samples.stock,samples.reorder_level
      FROM (
        SELECT 'DRK-001' AS sku,'Cà phê rang xay 250g' AS name,'Đồ uống' AS category,89000 AS price,24 AS stock,5 AS reorder_level
        UNION ALL SELECT 'DRK-002','Trà ô long túi lọc','Đồ uống',65000,18,5
        UNION ALL SELECT 'FOD-001','Bánh quy bơ hộp','Thực phẩm',48000,32,8
        UNION ALL SELECT 'HOM-001','Bình giữ nhiệt 500ml','Gia dụng',159000,12,3
        UNION ALL SELECT 'HOM-002','Túi vải tái sử dụng','Gia dụng',35000,40,10
      ) AS samples JOIN categories ON categories.name=samples.category`);
  }
}
