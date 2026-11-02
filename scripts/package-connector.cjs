const fs=require('node:fs/promises'),path=require('node:path');
const {zip}=require('../browser-downloads.js');
(async()=>{
  const files=[];
  for(const name of ['manifest.json','background.js','bridge.js','README.md'])files.push({name,blob:new Blob([await fs.readFile(path.join(__dirname,'../extension',name))])});
  files.push({name:'LICENSE',blob:new Blob([await fs.readFile(path.join(__dirname,'../LICENSE'))])});
  const data=await zip(files),directory=path.join(__dirname,'../downloads');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'citation-workflow-connector.zip'),Buffer.from(await data.arrayBuffer()));
  console.log('Packaged optional connector:',data.size,'bytes');
})().catch(error=>{console.error(error);process.exitCode=1;});
