import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('../scripts/package-plugin.mjs',import.meta.url));
test('release packaging includes only public manifest, MCP config and icon', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'drop-it-package-test-'));
  try {
    const settings=join(dir,'settings.json');
    await writeFile(settings,JSON.stringify({origin:'https://synthetic.example.test',publisher:'Synthetic publisher',supportEmail:'support@example.test',demoRecordingUrl:'https://synthetic.example.test/demo',countries:['US']}));
    execFileSync(process.execPath,[script,settings],{cwd:dir,stdio:'pipe'});
    const zip=join(dir,'dist/drop-it-plugin.zip');
    const entries=execFileSync('unzip',['-Z1',zip],{encoding:'utf8'}).trim().split('\n').sort();
    assert.deepEqual(entries,['.codex-plugin/plugin.json','.mcp.json','assets/icon.svg']);
    const manifest=JSON.parse(execFileSync('unzip',['-p',zip,'.codex-plugin/plugin.json'],{encoding:'utf8'}));
    assert.equal(manifest.interface.developerName,'Synthetic publisher');
    assert.equal(manifest.extensions['com.openai'].review.test_cases.positive.length,5);
    assert.equal(manifest.extensions['com.openai'].review.test_cases.negative.length,3);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('incomplete or credential-bearing release settings cannot create a package',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'drop-it-package-reject-'));
  try {
    const settings=join(dir,'settings.json');
    for (const data of [{origin:'https://your-domain.example',publisher:''},{origin:'https://synthetic.example.test',publisher:'Synthetic',supportEmail:'support@example.test',demoRecordingUrl:'https://synthetic.example.test/demo',countries:['US'],apiKey:'invalid-fixture-value'}]) {
      await writeFile(settings,JSON.stringify(data));
      assert.throws(()=>execFileSync(process.execPath,[script,settings],{cwd:dir,stdio:'pipe'}));
      await assert.rejects(access(join(dir,'dist/drop-it-plugin.zip')));
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('draft packaging omits a missing video and does not create a submission-ready archive',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'drop-it-package-draft-'));
  try {
    const settings=join(dir,'settings.json');
    await writeFile(settings,JSON.stringify({origin:'https://synthetic.example.test',publisher:'Synthetic',supportEmail:'support@example.test',demoRecordingUrl:'',countries:['US']}));
    assert.throws(()=>execFileSync(process.execPath,[script,settings],{cwd:dir,stdio:'pipe'}));
    execFileSync(process.execPath,[script,settings,'--draft'],{cwd:dir,stdio:'pipe'});
    await assert.rejects(access(join(dir,'dist/drop-it-plugin.zip')));
    const zip=join(dir,'dist/drop-it-plugin-draft.zip');
    const manifest=JSON.parse(execFileSync('unzip',['-p',zip,'.codex-plugin/plugin.json'],{encoding:'utf8'}));
    assert.equal(manifest.extensions['com.openai'].review.demo_recording_url,undefined);
    assert.equal(manifest.interface.privacyPolicyURL,'https://synthetic.example.test/privacy');
  } finally {await rm(dir,{recursive:true,force:true});}
});
