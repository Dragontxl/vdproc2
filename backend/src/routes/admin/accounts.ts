import { Hono } from 'hono';
import { AccountService } from '../../services/AccountService';
import { CryptoService } from '../../services/CryptoService';
import { Bindings } from '../../types/env';

const accountRoutes = new Hono();

accountRoutes.get('/github', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const accounts = await service.listGitHubAccounts();
  
  return c.json({ code: 200, data: accounts, msg: 'success' });
});

accountRoutes.post('/github', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  const account = await service.createGitHubAccount(body);
  
  return c.json({ code: 201, data: account, msg: 'Account created successfully' }, 201);
});

accountRoutes.put('/github/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  const updated = await service.updateGitHubAccount(parseInt(c.req.param('id')), body);
  
  if (!updated) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: updated, msg: 'Account updated successfully' });
});

accountRoutes.delete('/github/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const deleted = await service.deleteGitHubAccount(parseInt(c.req.param('id')));
  
  if (!deleted) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: null, msg: 'Account deleted successfully' });
});

accountRoutes.get('/ai', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const accounts = await service.listAIAccounts();
  
  return c.json({ code: 200, data: accounts, msg: 'success' });
});

accountRoutes.post('/ai/release-all', async (c) => {
  const service = new AccountService(c.env as Bindings);
  await service.env.DB.prepare(`
    UPDATE ai_accounts SET cooldown_until = NULL, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE cooldown_until IS NOT NULL
  `).run();
  
  const accounts = await service.listAIAccounts();
  const lockedCount = accounts.filter((acc: any) => acc.cooldown_until !== null).length;
  
  return c.json({ 
    code: 200, 
    data: { releasedCount: accounts.length - lockedCount, remainingLocked: lockedCount }, 
    msg: 'All AI accounts released successfully' 
  });
});

accountRoutes.post('/ai', async (c) => {
  try {
    const service = new AccountService(c.env as Bindings);
    const body = await c.req.json();
    
    const account = await service.createAIAccount(body);
    
    return c.json({ code: 201, data: account, msg: 'Account created successfully' }, 201);
  } catch (error) {
    console.error('Create AI account error:', error);
    return c.json({ code: 500, data: null, msg: 'Failed to create account: ' + (error as Error).message }, 500);
  }
});

accountRoutes.put('/ai/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  const updated = await service.updateAIAccount(parseInt(c.req.param('id')), body);
  
  if (!updated) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: updated, msg: 'Account updated successfully' });
});

accountRoutes.delete('/ai/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const deleted = await service.deleteAIAccount(parseInt(c.req.param('id')));
  
  if (!deleted) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: null, msg: 'Account deleted successfully' });
});

accountRoutes.post('/ai/:id/health', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const result = await service.checkAIAccountHealth(parseInt(c.req.param('id')));

  return c.json({ code: 200, data: result, msg: 'Health check completed' });
});

accountRoutes.get('/ai/:id/debug', async (c) => {
  const cryptoService = new CryptoService(c.env as Bindings);
  const result = await (c.env as Bindings).DB.prepare('SELECT id, api_key_encrypted, base_url FROM ai_accounts WHERE id = ?')
    .bind(parseInt(c.req.param('id'))).first();

  if (!result) {
    return c.json({ code: 404, data: null, msg: 'Not found' }, 404);
  }

  const env = c.env as Bindings;
  const encryptionKey = env.ENCRYPTION_KEY;
  const storedKey = (result as any).api_key_encrypted;
  let decryptedKey = '';
  let decryptError = '';

  try {
    decryptedKey = await cryptoService.decrypt(storedKey);
  } catch (e) {
    decryptError = (e as Error).message;
  }

  let testEncrypt = '';
  let testEncryptError = '';
  try {
    testEncrypt = await cryptoService.encrypt('test-key-123');
  } catch (e) {
    testEncryptError = (e as Error).message;
  }
  let testDecrypt = '';
  let testDecryptError = '';
  try {
    testDecrypt = await cryptoService.decrypt(testEncrypt);
  } catch (e) {
    testDecryptError = (e as Error).message;
  }

  return c.json({
    code: 200,
    data: {
      id: (result as any).id,
      encryptionKeyLength: encryptionKey?.length || 0,
      encryptionKeyIsSet: !!encryptionKey,
      storedKeyLength: storedKey?.length,
      storedKeyPrefix: storedKey?.substring(0, 10),
      decryptedKeyLength: decryptedKey.length,
      decryptedKeyPrefix: decryptedKey.substring(0, 4),
      decryptError,
      testEncryptLength: testEncrypt.length,
      testEncryptError,
      testDecryptResult: testDecrypt,
      testDecryptError,
    },
    msg: 'Debug info'
  });
});

accountRoutes.get('/github/:githubId/bindings', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const bindings = await service.getBoundAIAccounts(parseInt(c.req.param('githubId')));
  return c.json({ code: 200, data: bindings, msg: 'success' });
});

accountRoutes.post('/github/:githubId/bindings', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  try {
    await service.bindAIAccount(parseInt(c.req.param('githubId')), body.ai_account_id, body.priority || 0);
    return c.json({ code: 200, data: null, msg: '绑定成功' });
  } catch (error) {
    return c.json({ code: 400, data: null, msg: (error as Error).message }, 400);
  }
});

accountRoutes.put('/bindings/:bindingId/replace', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  try {
    await service.replaceBoundAIAccount(parseInt(c.req.param('bindingId')), body.new_ai_account_id);
    return c.json({ code: 200, data: null, msg: '更换成功' });
  } catch (error) {
    return c.json({ code: 400, data: null, msg: (error as Error).message }, 400);
  }
});

accountRoutes.put('/bindings/:bindingId', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  try {
    await service.updateBinding(parseInt(c.req.param('bindingId')), {
      ai_account_id: body.ai_account_id,
      priority: body.priority,
    });
    return c.json({ code: 200, data: null, msg: '更新成功' });
  } catch (error) {
    return c.json({ code: 400, data: null, msg: (error as Error).message }, 400);
  }
});

accountRoutes.delete('/bindings/:bindingId', async (c) => {
  const service = new AccountService(c.env as Bindings);
  await service.unbindAIAccount(parseInt(c.req.param('bindingId')));
  return c.json({ code: 200, data: null, msg: '解绑成功' });
});

accountRoutes.get('/ai/unbound', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const accounts = await service.getUnboundAIAccounts();
  return c.json({ code: 200, data: accounts, msg: 'success' });
});

export { accountRoutes };