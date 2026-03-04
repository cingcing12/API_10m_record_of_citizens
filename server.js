const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const SECRET_KEY = 'homework_super_secret_key'; 
const app = express();
app.use(cors());
app.use(express.json());
require('dotenv').config();

// Connect to your Database VM
const dbConfig = {
    host: process.env.host,
    user: process.env.user,
    password: process.env.pass,
    database: process.env.database
};

// New Endpoint: Get distinct locations for dropdowns
app.get('/api/locations', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const { type, province, district, commune } = req.query;

        let query = '';
        let params = [];

        if (type === 'province') {
            query = 'SELECT DISTINCT province AS name FROM people WHERE province IS NOT NULL ORDER BY province';
        } else if (type === 'district' && province) {
            query = 'SELECT DISTINCT district AS name FROM people WHERE province = ? ORDER BY district';
            params.push(province);
        } else if (type === 'commune' && district) {
            query = 'SELECT DISTINCT commune AS name FROM people WHERE province = ? AND district = ? ORDER BY commune';
            params.push(province, district);
        } else if (type === 'village' && commune) {
            query = 'SELECT DISTINCT village AS name FROM people WHERE province = ? AND district = ? AND commune = ? ORDER BY village';
            params.push(province, district, commune);
        } else {
            return res.json({ success: true, data: [] }); // Invalid request
        }

        const [rows] = await connection.execute(query, params);
        await connection.end();
        
        // Extract just the names into a simple array
        res.json({ success: true, data: rows.map(r => r.name) });
    } catch (error) {
        console.error("Location API Error:", error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);

        // 1. Get query parameters
        const { name, gender, age, province, district, commune, village, page = 1 } = req.query;
        const limit = 100;
        const offset = (parseInt(page) - 1) * limit;

        // 2. Build the dynamic WHERE clause
        let whereClauses = ['1=1'];
        let queryParams = [];

        if (name) {
            whereClauses.push('full_name LIKE ?');
            queryParams.push(`%${name}%`);
        }
        if (gender) {
            whereClauses.push('gender = ?');
            queryParams.push(gender);
        }
        if (province) {
            whereClauses.push('province = ?');
            queryParams.push(province);
        }
        if (district) {
            whereClauses.push('district = ?');
            queryParams.push(district);
        }
        if (commune) {
            whereClauses.push('commune = ?');
            queryParams.push(commune);
        }
        if (village) {
            whereClauses.push('village = ?');
            queryParams.push(village);
        }
        
        // Dynamic Age Logic (Convert age to DOB range for fast index searching)
        if (age) {
            const currentYear = new Date().getFullYear();
            const birthYear = currentYear - parseInt(age);
            whereClauses.push('dob BETWEEN ? AND ?');
            queryParams.push(`${birthYear}-01-01`, `${birthYear}-12-31`);
        }

        const whereString = whereClauses.join(' AND ');

        // 3. Query to get the total count for pagination
        const countQuery = `SELECT COUNT(id) as total FROM people WHERE ${whereString}`;
        const [countResult] = await connection.execute(countQuery, queryParams);
        const totalRecords = countResult[0].total;

        // 4. Query to get the actual 100 rows with dynamic age calculation
        // We append the LIMIT and OFFSET parameters at the end
        const dataQuery = `
            SELECT 
                id, full_name, gender, dob, province, district, commune, village,
                TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age 
            FROM people 
            WHERE ${whereString} 
            LIMIT ? OFFSET ?
        `;
        
        const dataParams = [...queryParams, limit, offset];
        const [rows] = await connection.execute(dataQuery, dataParams);

        await connection.end();

        // 5. Send response to frontend
        res.json({
            success: true,
            total_records: totalRecords,
            total_pages: Math.ceil(totalRecords / limit),
            current_page: parseInt(page),
            data: rows
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ==========================================
// REQUIREMENT 3: USER MANAGEMENT
// ==========================================

// 1. Register a new Admin User
app.post('/api/register', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const { username, password } = req.body;
        
        // Hash the password for security
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await connection.execute(
            'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', 
            [username, hashedPassword, 'admin']
        );
        await connection.end();
        res.json({ success: true, message: 'User created successfully!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Username might already exist.' });
    }
});

// 2. Login
app.post('/api/login', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const { username, password } = req.body;

        const [users] = await connection.execute('SELECT * FROM users WHERE username = ?', [username]);
        await connection.end();

        if (users.length === 0) return res.status(401).json({ success: false, message: 'User not found' });

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) return res.status(401).json({ success: false, message: 'Invalid password' });

        // Generate a token valid for 2 hours
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY, { expiresIn: '2h' });
        
        res.json({ success: true, token: token, username: user.username });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Login error' });
    }
});

// Middleware to protect routes (Only logged in users can pass)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ success: false, message: 'Access Denied: No Token' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Invalid Token' });
        req.user = user;
        next();
    });
};

// ==========================================
// REQUIREMENT 4: EDIT HISTORY & UPDATES
// ==========================================

// 3. Edit a Person
app.put('/api/people/:id', authenticateToken, async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const personId = req.params.id;
        const { full_name, gender, dob, province, district, commune, village } = req.body;

        const query = `
            UPDATE people 
            SET full_name = ?, gender = ?, dob = ?, province = ?, district = ?, commune = ?, village = ?
            WHERE id = ?
        `;
        await connection.execute(query, [full_name, gender, dob, province, district, commune, village, personId]);
        
        // NEW: Log the edit action to the global history table!
        await connection.execute(
            'INSERT INTO admin_history (action, target_username, performed_by) VALUES (?, ?, ?)', 
            ['EDITED CITIZEN', full_name, req.user.username]
        );

        await connection.end();

        res.json({ success: true, message: 'Record updated and logged!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Failed to update record' });
    }
});

// 4. View Edit History for a specific person
app.get('/api/history/:id', authenticateToken, async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const personId = req.params.id;

        const [history] = await connection.execute(
            'SELECT * FROM edit_history WHERE person_id = ? ORDER BY edited_at DESC', 
            [personId]
        );
        await connection.end();

        res.json({ success: true, data: history });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Failed to fetch history' });
    }
});

// ==========================================
// REQUIREMENT 5: ADMIN MANAGEMENT & LOGS
// ==========================================

// Get all admins
app.get('/api/admins', authenticateToken, async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [admins] = await connection.execute('SELECT id, username, role FROM users');
        await connection.end();
        res.json({ success: true, data: admins });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch admins' });
    }
});

// Create new admin (with history log)
app.post('/api/admins', authenticateToken, async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await connection.execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hashedPassword, 'admin']);
        await connection.execute('INSERT INTO admin_history (action, target_username, performed_by) VALUES (?, ?, ?)', ['CREATED', username, req.user.username]);
        
        await connection.end();
        res.json({ success: true, message: 'Admin created successfully!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Username might already exist.' });
    }
});

// Delete admin (with history log)
app.delete('/api/admins/:id', authenticateToken, async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const adminId = req.params.id;
        
        // Get username before deleting for the log
        const [target] = await connection.execute('SELECT username FROM users WHERE id = ?', [adminId]);
        if (target.length > 0) {
            await connection.execute('DELETE FROM users WHERE id = ?', [adminId]);
            await connection.execute('INSERT INTO admin_history (action, target_username, performed_by) VALUES (?, ?, ?)', ['DELETED', target[0].username, req.user.username]);
        }
        
        await connection.end();
        res.json({ success: true, message: 'Admin deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete admin' });
    }
});

// Get Admin History
app.get('/api/admin-history', authenticateToken, async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [history] = await connection.execute('SELECT * FROM admin_history ORDER BY action_date DESC');
        await connection.end();
        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch admin history' });
    }
});
// ==========================================
// REQUIREMENT: PROVINCE DEMOGRAPHIC SUMMARY
// ==========================================
app.get('/api/province-summary', authenticateToken, async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        let { province, age_from, age_to } = req.query;

        // NO MORE DEFAULTS! Strictly require the user to input the age range.
        if (age_from === '' || age_to === '' || age_from === undefined || age_to === undefined) {
            return res.status(400).json({ success: false, message: 'Please provide both a starting and ending age.' });
        }

        age_from = parseInt(age_from);
        age_to = parseInt(age_to);

        if (age_to < age_from) {
            return res.status(400).json({ success: false, message: 'Age To cannot be less than Age From.' });
        }

        if (age_to - age_from > 50) {
            return res.status(400).json({ success: false, message: 'To prevent server lag, the age range cannot exceed 50 years at once.' });
        }

        let query = `
            SELECT 
                province, 
                TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age, 
                COUNT(*) as total_count 
            FROM people 
            WHERE dob IS NOT NULL 
            AND TIMESTAMPDIFF(YEAR, dob, CURDATE()) BETWEEN ? AND ?
        `;
        let params = [age_from, age_to];

        if (province && province !== 'All' && province !== '') {
            query += ` AND province = ?`;
            params.push(province);
        }

        query += ` GROUP BY province, age ORDER BY province, age`;

        const [results] = await connection.execute(query, params);
        await connection.end();

        const summary = {};
        results.forEach(row => {
            if (!summary[row.province]) {
                summary[row.province] = { province: row.province, total: 0, ages: {} };
                for (let i = age_from; i <= age_to; i++) summary[row.province].ages[i] = 0;
            }
            summary[row.province].ages[row.age] = row.total_count;
            summary[row.province].total += row.total_count;
        });

        res.json({ success: true, data: Object.values(summary), age_from, age_to });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Failed to generate summary' });
    }
});
// Start the server
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server API is running on http://192.168.80.129:${PORT}`);
});
