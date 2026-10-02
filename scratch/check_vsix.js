const fs = require('fs');
const cp = require('child_process');

try {
  fs.copyFileSync('academic-pdf-reader-0.1.0.vsix', 'scratch/temp.zip');
  cp.execSync('powershell -Command "Expand-Archive -Path scratch/temp.zip -DestinationPath scratch/vsix_contents -Force"');
  console.log('Unzipped vsix successfully');
  
  const vsixViewer = fs.readFileSync('scratch/vsix_contents/extension/media/viewer.js', 'utf8');
  const diskViewer = fs.readFileSync('media/viewer.js', 'utf8');
  console.log('VSIX viewer.js length:', vsixViewer.length);
  console.log('Disk viewer.js length:', diskViewer.length);
  console.log('Equal:', vsixViewer === diskViewer);
  
  const vsixExt = fs.readFileSync('scratch/vsix_contents/extension/dist/extension.js', 'utf8');
  const diskExt = fs.readFileSync('dist/extension.js', 'utf8');
  console.log('VSIX extension.js length:', vsixExt.length);
  console.log('Disk extension.js length:', diskExt.length);
  console.log('Ext Equal:', vsixExt === diskExt);
} catch (e) {
  console.error(e);
}
