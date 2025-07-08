// Simple Express server for Rapid Label
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8383;

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Rapid Label server running at http://localhost:${PORT}`);
});
