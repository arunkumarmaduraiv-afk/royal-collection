const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'saree-secret-key';
const DATA_PATH = path.join(__dirname, 'data', 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '-');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataFile() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(
      DATA_PATH,
      JSON.stringify(
        {
          admin: {
            username: 'admin',
            passwordHash: ''
          },
          company: {
            name: 'Saree Availability Co.',
            logoPath: ''
          },
          categories: [],
          products: [],
          availability: {}
        },
        null,
        2
      )
    );
  }
}

ensureDataFile();

function readData() {
  const content = fs.readFileSync(DATA_PATH, 'utf-8');
  return JSON.parse(content);
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function ensureAvailabilityForCategory(data, categoryId) {
  if (!data.availability[categoryId]) {
    data.availability[categoryId] = {};
  }
  for (let day = 1; day <= 31; day += 1) {
    if (typeof data.availability[categoryId][day] === 'undefined') {
      data.availability[categoryId][day] = true;
    }
  }
}

function attachAvailability(data) {
  data.categories.forEach((category) => ensureAvailabilityForCategory(data, category.id));
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ message: 'Missing authorization header' });
  }
  const [, token] = header.split(' ');
  if (!token) {
    return res.status(401).json({ message: 'Invalid authorization header' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }
  const data = readData();
  if (username !== data.admin.username) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const isMatch = bcrypt.compareSync(password, data.admin.passwordHash);
  if (!isMatch) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1d' });
  return res.json({ token });
});

app.get('/api/company', (_req, res) => {
  const data = readData();
  return res.json(data.company);
});

app.put('/api/company', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Company name is required' });
  }
  const data = readData();
  data.company.name = name;
  writeData(data);
  return res.json(data.company);
});

app.post('/api/company/logo', authMiddleware, upload.single('logo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Logo file is required' });
  }
  const data = readData();
  data.company.logoPath = `/uploads/${req.file.filename}`;
  writeData(data);
  return res.json(data.company);
});

app.get('/api/categories', (_req, res) => {
  const data = readData();
  attachAvailability(data);
  writeData(data);
  return res.json(data.categories.map((category) => ({
    ...category,
    availability: data.availability[category.id]
  })));
});

app.post('/api/categories', authMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Category name is required' });
  }
  const data = readData();
  const newCategory = {
    id: `cat-${uuid()}`,
    name,
    description: description || ''
  };
  data.categories.push(newCategory);
  ensureAvailabilityForCategory(data, newCategory.id);
  writeData(data);
  return res.status(201).json(newCategory);
});

app.put('/api/categories/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;
  const data = readData();
  const category = data.categories.find((c) => c.id === id);
  if (!category) {
    return res.status(404).json({ message: 'Category not found' });
  }
  category.name = name || category.name;
  category.description = description ?? category.description;
  writeData(data);
  return res.json(category);
});

app.delete('/api/categories/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const data = readData();
  const exists = data.categories.some((c) => c.id === id);
  if (!exists) {
    return res.status(404).json({ message: 'Category not found' });
  }
  data.categories = data.categories.filter((c) => c.id !== id);
  delete data.availability[id];
  data.products = data.products.filter((p) => p.categoryId !== id);
  writeData(data);
  return res.json({ message: 'Category removed' });
});

app.get('/api/products', (_req, res) => {
  const data = readData();
  return res.json(data.products);
});

app.post('/api/products', authMiddleware, (req, res) => {
  const { name, categoryId, description, price } = req.body;
  if (!name || !categoryId) {
    return res.status(400).json({ message: 'Product name and category are required' });
  }
  const data = readData();
  const categoryExists = data.categories.some((c) => c.id === categoryId);
  if (!categoryExists) {
    return res.status(400).json({ message: 'Category does not exist' });
  }
  const product = {
    id: `prod-${uuid()}`,
    name,
    categoryId,
    description: description || '',
    price: price || 0,
    photos: []
  };
  data.products.push(product);
  writeData(data);
  return res.status(201).json(product);
});

app.put('/api/products/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, categoryId, description, price } = req.body;
  const data = readData();
  const product = data.products.find((p) => p.id === id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }
  if (categoryId) {
    const categoryExists = data.categories.some((c) => c.id === categoryId);
    if (!categoryExists) {
      return res.status(400).json({ message: 'Category does not exist' });
    }
    product.categoryId = categoryId;
  }
  product.name = name || product.name;
  product.description = description ?? product.description;
  product.price = typeof price === 'number' ? price : product.price;
  writeData(data);
  return res.json(product);
});

app.delete('/api/products/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const data = readData();
  const exists = data.products.some((p) => p.id === id);
  if (!exists) {
    return res.status(404).json({ message: 'Product not found' });
  }
  data.products = data.products.filter((p) => p.id !== id);
  writeData(data);
  return res.json({ message: 'Product removed' });
});

app.post('/api/products/:id/photos', authMiddleware, upload.array('photos', 5), (req, res) => {
  const { id } = req.params;
  const data = readData();
  const product = data.products.find((p) => p.id === id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }
  const filePaths = (req.files || []).map((file) => `/uploads/${file.filename}`);
  product.photos = [...product.photos, ...filePaths];
  writeData(data);
  return res.json(product);
});

app.get('/api/categories/:id/availability', (req, res) => {
  const { id } = req.params;
  const data = readData();
  const category = data.categories.find((c) => c.id === id);
  if (!category) {
    return res.status(404).json({ message: 'Category not found' });
  }
  ensureAvailabilityForCategory(data, id);
  writeData(data);
  return res.json(data.availability[id]);
});

app.put('/api/categories/:id/availability', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { day, available } = req.body;
  const dayNumber = Number(day);
  if (!dayNumber || dayNumber < 1 || dayNumber > 31) {
    return res.status(400).json({ message: 'Day must be between 1 and 31' });
  }
  const data = readData();
  const category = data.categories.find((c) => c.id === id);
  if (!category) {
    return res.status(404).json({ message: 'Category not found' });
  }
  ensureAvailabilityForCategory(data, id);
  data.availability[id][dayNumber] = Boolean(available);
  writeData(data);
  return res.json(data.availability[id]);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

