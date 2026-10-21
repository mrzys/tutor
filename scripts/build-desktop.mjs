import { spawnSync } from 'node:child_process';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const [command,args] of [[npm,['run','build','--prefix','desktop']],['cargo',['check','--manifest-path','desktop/src-tauri/Cargo.toml']]]) {
  const result=spawnSync(command,args,{stdio:'inherit',shell:process.platform==='win32'&&command.endsWith('.cmd')});
  if(result.error) throw result.error;
  if(result.status!==0) process.exit(result.status??1);
}
