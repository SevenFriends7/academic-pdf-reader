const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// 1. Extract HTML from pdfEditorProvider.ts
const providerCode = fs.readFileSync('src/pdfEditorProvider.ts', 'utf8');
const htmlStart = providerCode.indexOf('<!DOCTYPE html>');
const htmlEnd = providerCode.lastIndexOf('</html>') + 7;
let fullHtml = providerCode.slice(htmlStart, htmlEnd);

// Replace URIs and CSP for local testing
fullHtml = fullHtml.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
fullHtml = fullHtml.replace(/\$\{cssUri\}\?v=\$\{v\}/g, '../media/viewer.css');
fullHtml = fullHtml.replace(/\$\{pdfJsUri\}/g, '../media/pdfjs/pdf.min.js');
fullHtml = fullHtml.replace(/\$\{scriptUri\}\?v=\$\{v\}/g, '../media/viewer.js');
fullHtml = fullHtml.replace(/\$\{pdfWorkerUri\}/g, '../media/pdfjs/pdf.worker.min.js');
fullHtml = fullHtml.replace(/nonce="\$\{nonce\}"/g, '');

// Inject mock acquireVsCodeApi before viewer.js
const mockScript = `
<script>
  window.acquireVsCodeApi = function() {
    return {
      postMessage: function(msg) {
        console.log('[VSCODE_MSG]:', JSON.stringify(msg));
      },
      getState: function() { return {}; },
      setState: function() {}
    };
  };
</script>
`;
fullHtml = fullHtml.replace('<script src="../media/viewer.js"', mockScript + '<script src="../media/viewer.js"');

// Inject test simulation script at the end
const testScript = `
<script>
window.addEventListener('load', () => {
  setTimeout(() => {
    try {
      console.log('Testing AI button clicks...');
      const modal = document.getElementById('aiAssistantModal');
      console.log('Modal exists:', !!modal);
      console.log('Modal display initially:', modal ? modal.style.display : null);

      // Check if we can trigger openAiAssistantModal
      const testBtn = document.createElement('button');
      testBtn.className = 'btn-row-ai';
      testBtn.setAttribute('data-sent-idx', '0');
      document.body.appendChild(testBtn);

      // Check all AI buttons in DOM
      console.log('btnFocusAi exists:', !!document.getElementById('btnFocusAi'));
      console.log('btnAskAiPopover exists:', !!document.getElementById('btnAskAiPopover'));
      console.log('btnSelectionAi exists:', !!document.getElementById('btnSelectionAi'));
      console.log('ctxBtnAskAi exists:', !!document.getElementById('ctxBtnAskAi'));

      // Test clicking btnFocusAi directly
      const btnFocusAi = document.getElementById('btnFocusAi');
      if (btnFocusAi) {
        console.log('Clicking btnFocusAi directly...');
        btnFocusAi.click();
        console.log('After btnFocusAi click, modal display:', modal.style.display);
      }
    } catch(err) {
      console.error('Test error:', err);
    }
  }, 500);
});
</script>
`;
fullHtml = fullHtml.replace('</body>', testScript + '</body>');

fs.writeFileSync('scratch/test_page.html', fullHtml, 'utf8');
console.log('Wrote scratch/test_page.html');
