# 📦 Rapid Label Printer

Um aplicativo web moderno para impressão rápida de etiquetas de containers e produtos.

## 🚀 Início Rápido

### Pré-requisitos
- Node.js (versão 12 ou superior)

### Instalação e Execução

1. **Navegar para o diretório do projeto:**
   ```bash
   cd "/Users/joaomarcos/Desktop/untitled folder/LabelsApp_Final"
   ```

2. **Iniciar o servidor:**
   ```bash
   npm start
   ```

3. **Acessar o aplicativo:**
   - Abra seu navegador e acesse: http://localhost:8383

## 🎯 Funcionalidades

### ✨ Labels do Dia
- Lista pré-definida de etiquetas para containers do dia
- Preview antes da impressão
- Suporte para tamanhos A3 e A4
- Interface visual com cards informativos

### ✏️ Criação Manual
- Formulário para criação de etiquetas personalizadas
- Validação em tempo real
- Seleção visual de tamanho (A3/A4)
- Data automática ou manual
- Preview antes da impressão

### 🖨️ Sistema de Impressão
- Geração dinâmica de HTML otimizado para impressão
- Tamanhos precisos (A3: 297x420mm, A4: 210x297mm)
- Formatação profissional com fonte Arial
- Auto-print após geração

## 📂 Estrutura do Projeto

```
LabelsApp_Final/
├── index.html          # Página principal com modais
├── modal.js            # Lógica JavaScript dos modais
├── styles.css          # Estilos CSS globais
├── server.js           # Servidor HTTP local
├── package.json        # Configurações do projeto
├── README.md           # Este arquivo
├── label-a3.html       # Template A3 (legado)
├── label-a4.html       # Template A4 (legado)
└── manual-label.html   # Página manual (legado)
```

## 🔧 Configuração

### Porta do Servidor
O servidor está configurado para rodar na **porta 8383** por padrão.

### Dados dos Labels
Para modificar os labels do dia, edite o array `todaysLabels` no arquivo `modal.js`:

```javascript
const todaysLabels = [
    {
        id: 1,
        sku: "72452",
        code: "R3118-REFLECTOR-AL",
        qty: 89,
        date: "08/07/25",
        size: "A4"
    },
    // Adicione mais labels aqui...
];
```

## 💡 Como Usar

### 1. Labels do Dia
1. Clique em "Labels for Today's Container"
2. Selecione o label desejado da lista
3. Use "Preview" para visualizar ou "Print" para imprimir

### 2. Label Manual
1. Clique em "Create a Manual Label"
2. Preencha os campos obrigatórios (SKU, CODE, QTY)
3. Selecione o tamanho (A4 ou A3)
4. Use "Preview" para visualizar ou "Print Label" para imprimir

## 🎨 Personalização

### Estilos
Modifique `styles.css` para alterar:
- Cores e temas
- Fontes e tamanhos
- Layout e espaçamentos
- Animações e transições

### Templates de Etiqueta
Ajuste as dimensões e formatação no arquivo `modal.js` na função `generateLabelHTML()`.

## 🐛 Solução de Problemas

### Porta já em uso
Se a porta 8383 estiver ocupada:
```bash
# Verificar processos na porta 8383
lsof -i :8383

# Parar o processo se necessário
kill -9 <PID>
```

### Problemas de Impressão
- Certifique-se de que o navegador tem permissão para acessar a impressora
- Verifique as configurações de página na impressão
- Use o Preview para verificar a formatação antes de imprimir

## 📱 Compatibilidade

- ✅ Chrome/Chromium
- ✅ Firefox
- ✅ Safari
- ✅ Edge
- 📱 Responsivo para dispositivos móveis

## 🔄 Comandos Disponíveis

```bash
npm start    # Inicia o servidor na porta 8383
npm run dev  # Mesmo que npm start (alias)
npm test     # Teste básico do servidor
```

## 📞 Suporte

Para dúvidas ou problemas:
1. Verifique se o Node.js está instalado
2. Confirme que a porta 8383 está disponível
3. Verifique os logs do console para erros

---

🚀 **Rapid Label Printer** - Impressão rápida e eficiente de etiquetas!
# Rapid-Labels
