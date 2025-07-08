const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8383;

// MIME types para diferentes tipos de arquivo
const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    // Parse da URL
    const parsedUrl = url.parse(req.url);
    let pathname = parsedUrl.pathname;
    
    // Se a URL é '/', serve o index.html
    if (pathname === '/') {
        pathname = '/index.html';
    }
    
    // Caminho completo do arquivo
    const filePath = path.join(__dirname, pathname);
    
    // Extensão do arquivo
    const ext = path.extname(pathname).toLowerCase();
    
    // MIME type
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    // Verificar se o arquivo existe
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            // Arquivo não encontrado
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>404 - Not Found</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                        h1 { color: #dc3545; }
                        a { color: #007bff; text-decoration: none; }
                    </style>
                </head>
                <body>
                    <h1>404 - Page Not Found</h1>
                    <p>The requested file <code>${pathname}</code> was not found.</p>
                    <a href="/">← Back to Home</a>
                </body>
                </html>
            `);
            return;
        }
        
        // Ler e servir o arquivo
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>500 - Server Error</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #dc3545; }
                            a { color: #007bff; text-decoration: none; }
                        </style>
                    </head>
                    <body>
                        <h1>500 - Internal Server Error</h1>
                        <p>Sorry, there was an error reading the file.</p>
                        <a href="/">← Back to Home</a>
                    </body>
                    </html>
                `);
                return;
            }
            
            // Servir o arquivo
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    });
});

server.listen(PORT, () => {
    console.log('🚀 Rapid Label Printer Server Started!');
    console.log(`📦 Server running at: http://localhost:${PORT}`);
    console.log('🖨️  Ready to print labels!');
    console.log('\n📋 Available endpoints:');
    console.log(`   • Home Page: http://localhost:${PORT}/`);
    console.log(`   • Direct Access: http://localhost:${PORT}/index.html`);
    console.log('\n⏹️  Press Ctrl+C to stop the server');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Server shutting down...');
    server.close(() => {
        console.log('✅ Server stopped successfully!');
        process.exit(0);
    });
});

// Error handling
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`❌ Port ${PORT} is already in use!`);
        console.log('💡 Try stopping other servers or use a different port.');
    } else {
        console.log('❌ Server error:', err.message);
    }
});
