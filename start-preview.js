process.env.PORT = '3002';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const app = require('./server.js');
app.listen(3002, () => console.log('Career Triangulation running at http://localhost:3002'));
