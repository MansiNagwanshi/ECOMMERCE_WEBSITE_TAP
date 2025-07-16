import express from 'express';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import bodyParser from 'body-parser';
import cors from 'cors';
import { v4 as uuid } from 'uuid';


import { fileURLToPath } from 'url';
import { dirname } from 'path';

const app = express();

const __filename = fileURLToPath(import.meta.url); 
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_change_me';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------  IN‑MEMORY DB  ---------------------
const users = [];     // { id, name, email, passwordHash, role }
const products = [];  // { id, name, category, price, stock }
const carts = {};     // userId -> [ { productId, quantity } ]
const orders = [];    // { id, userId, items:[{productId, quantity}], total, date }

// Seed one admin & some demo products
 (async () => {
  try {
    const adminPwdHash = await bcrypt.hash('admin123', 10);
    users.push({ id: uuid(), name: 'Admin', email: 'admin@example.com', passwordHash: adminPwdHash, role: 'admin' });

    products.push(
      { id: uuid(), name: 'Running Shoes', category: 'Footwear', price: 3500, stock: 50 },
      { id: uuid(), name: 'Denim Jacket', category: 'Clothing', price: 2200, stock: 30 },
      { id: uuid(), name: 'Wireless Mouse', category: 'Electronics', price: 799, stock: 100 }
    );
  } catch (err) {
    console.error('Error seeding data:', err);
  }
})();


// -----------------  HELPER / MIDDLEWARE  -----------------
function generateToken(user) {
    return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '2h' });
}

function authRequired(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ message: 'Missing token' });

    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
}

function roleRequired(role) {
    return (req, res, next) => {
        if (req.user.role !== role) return res.status(403).json({ message: 'Forbidden' });
        next();
    };
}



// Auth ----------------------------------------------------
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'All fields required' });
    if (users.find(u => u.email === email)) return res.status(409).json({ message: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id: uuid(), name, email, passwordHash, role: 'customer' };
    users.push(user);
    res.status(201).json({ token: generateToken(user) });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ token: generateToken(user) });
});

// Products ------------------------------------------------
app.get('/products', (req, res) => {
    console.log(products);
    const { page = 1, limit = 10, search = '', category } = req.query;
    let result = [...products];
    if (search) result = result.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
    if (category) result = result.filter(p => p.category.toLowerCase() === category.toLowerCase());

    // Pagination
    const start = (page - 1) * limit;
    const paginated = result.slice(start, start + Number(limit));
    res.json({ total: result.length, page: Number(page), limit: Number(limit), data: paginated });
});

app.get('/products/:id', (req, res) => {
    const product = products.find(p => p.id === req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
});

// Admin product management
app.post('/products', authRequired, roleRequired('admin'), (req, res) => {
    const { name, category, price, stock } = req.body;
    if (!name || !category || price == null || stock == null) return res.status(400).json({ message: 'All fields required' });
    const product = { id: uuid(), name, category, price, stock };
    products.push(product);
    res.status(201).json(product);
});

app.put('/products/:id', authRequired, roleRequired('admin'), (req, res) => {
    const idx = products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ message: 'Product not found' });
    products[idx] = { ...products[idx], ...req.body };
    res.json(products[idx]);
});

app.delete('/products/:id', authRequired, roleRequired('admin'), (req, res) => {
    const idx = products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ message: 'Product not found' });
    const removed = products.splice(idx, 1);
    res.json({ removed });
});

// Cart ----------------------------------------------------
app.get('/cart', authRequired, (req, res) => {
    const cart = carts[req.user.id] || [];
    res.json(cart);
});

app.post('/cart', authRequired, (req, res) => {
    const { productId, quantity = 1 } = req.body;
    const product = products.find(p => p.id === productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const cart = carts[req.user.id] || [];
    const itemIdx = cart.findIndex(i => i.productId === productId);
    if (itemIdx === -1) cart.push({ productId, quantity });
    else cart[itemIdx].quantity += quantity;
    carts[req.user.id] = cart;
    res.json(cart);
});

app.put('/cart', authRequired, (req, res) => {
    const { productId, quantity } = req.body;
    const cart = carts[req.user.id] || [];
    const item = cart.find(i => i.productId === productId);
    if (!item) return res.status(404).json({ message: 'Item not in cart' });
    if (quantity <= 0) return res.status(400).json({ message: 'Quantity must be > 0' });
    item.quantity = quantity;
    res.json(cart);
});

app.delete('/cart/:productId', authRequired, (req, res) => {
    const cart = carts[req.user.id] || [];
    const idx = cart.findIndex(i => i.productId === req.params.productId);
    if (idx === -1) return res.status(404).json({ message: 'Item not in cart' });
    cart.splice(idx, 1);
    carts[req.user.id] = cart;
    res.json(cart);
});

// Orders --------------------------------------------------
app.post('/orders', authRequired, (req, res) => {
    const cart = carts[req.user.id] || [];
    if (cart.length === 0) return res.status(400).json({ message: 'Cart is empty' });

    // calculate total
    let total = 0;
    for (const item of cart) {
        const product = products.find(p => p.id === item.productId);
        if (!product) return res.status(400).json({ message: `Product ${item.productId} no longer exists` });
        if (item.quantity > product.stock) return res.status(400).json({ message: `Not enough stock for ${product.name}` });
        total += product.price * item.quantity;
        product.stock -= item.quantity;
    }

    const order = { id: uuid(), userId: req.user.id, items: [...cart], total, date: new Date() };
    orders.push(order);
    carts[req.user.id] = []; // empty cart
    res.status(201).json(order);
});

app.get('/orders', authRequired, (req, res) => {
    if (req.user.role === 'admin') return res.json(orders); // admin sees all
    const myOrders = orders.filter(o => o.userId === req.user.id);
    res.json(myOrders);
});
// --------------------  START SERVER  ---------------------
app.listen(PORT, () => console.log(`API running at http://localhost:${PORT}`));
