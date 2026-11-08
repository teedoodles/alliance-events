// Usage: npm run create-admin -- "Full Name" admin@alliance.edu.in "StrongPassword123" super_admin
require('dotenv').config();
const bcrypt = require('bcryptjs'), db = require('../src/db');
(async () => {
  const [name, email, password, role = 'super_admin'] = process.argv.slice(2);
  if (!name || !email || !password || password.length < 10) return console.error('Usage: npm run create-admin -- "Name" email "Password(10+ chars)" [super_admin|event_manager|checkin_staff]');
  const { error } = await db.from('admins').insert({ name, email: email.toLowerCase(), role, password_hash: await bcrypt.hash(password, 12) });
  console.log(error ? 'Failed: ' + error.message : `Admin created: ${email} (${role})`);
})();
