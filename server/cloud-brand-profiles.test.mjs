import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('cloud workspace save and hydration retain profile list and active selection including last-profile deletion', async t => {
  let stored = null;
  const client = {
    auth: {
      async getSession() { return { data: { session: {} } }; },
      async getUser() { return { data: { user: { id:'user-1', email:'test@example.test', user_metadata:{name:'Test'} } } }; },
    },
    from(table) {
      assert.equal(table, 'workspaces');
      return {
        select() { return this; },
        eq(field, id) { assert.equal(field,'user_id'); assert.equal(id,'user-1'); return this; },
        async maybeSingle() { return { data: stored }; },
        async upsert(value) { stored = structuredClone(value); return { error:null }; },
      };
    },
  };
  globalThis.__brandProfileClient = client;
  t.after(() => { delete globalThis.__brandProfileClient; });
  const source = readFileSync(new URL('../src/lib/auth.ts',import.meta.url),'utf8').replace(/^import \{ getAccessToken, getSupabaseClient, isCloudConfigured \} from '\.\/supabase';$/m, 'const getSupabaseClient = () => globalThis.__brandProfileClient; const isCloudConfigured = true;');
  const {outputText} = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
  const api = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  const first = { id:'a',name:'카페 A',tagline:'',instagram:'',location:'',color:'#254a3b' };
  const second = { ...first,id:'b',name:'카페 B' };
  const workspace = { brand:second, projects:[], brandProfiles:[first,second], activeBrandId:'b' };
  assert.deepEqual(await api.putWorkspace(workspace,'user-1'),workspace);
  assert.deepEqual(await api.getWorkspace(),workspace);
  const empty = { ...workspace, brandProfiles:[], activeBrandId:null };
  assert.deepEqual(await api.putWorkspace(empty,'user-1'),empty);
  assert.deepEqual(await api.getWorkspace(),empty);
});
