import {test,expect} from '@playwright/test';
import {buildSampleProject} from '../../files/src/sampleProject.js';
import {en} from '../../files/src/i18n/en.js';
import {fr} from '../../files/src/i18n/fr.js';

for(const lang of ['en','fr'])for(const cameras of [false,true])for(const clipboard of ['copied','denied','missing','pending']){
  test(`Share ${lang}, ${cameras?'cameras':'empty'}, clipboard ${clipboard}`,async({page},testInfo)=>{
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.addInitScript(({lang,clipboard})=>{
      window.addEventListener('unhandledrejection',e=>console.error('unhandledrejection: '+String(e.reason)));
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:clipboard==='missing'?undefined:{writeText:url=>{
        window['sharedUrl']=url;
        if(clipboard==='denied')return Promise.reject(new Error('Permission denied'));
        if(clipboard==='pending')return new Promise(()=>{});
        return Promise.resolve();
      }}});
    },{lang,clipboard});
    await page.goto('/');
    await page.locator('[data-action="show-settings"]').click();
    await page.locator('.ep-row').filter({has:page.locator('[data-i18n="settings.language"]')}).locator('select').selectOption(lang);
    await page.locator('#mdl-ok').click();
    const project=buildSampleProject();project.settings.language=lang;
    if(cameras){
      project.floors[0].CAMS[0].creds={user:'private-user',pass:'private-pass'};
      await page.locator('#load-up').setInputFiles({name:'share.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
      await expect(page.locator('.cam-grp')).toHaveCount(project.floors[0].CAMS.length);
    }
    // Click the child span to exercise delegated events.
    await page.locator('[data-action="share-link"] span').click();
    const bundle=lang==='fr'?fr:en;
    let url;
    if(clipboard==='copied'){
      await expect(page.locator('#toast')).toHaveText(bundle['notify.share_link_copied_to_clipboard_no_floor_plan_image']);
      url=await page.evaluate(()=>window['sharedUrl']);
    }else{
      await expect(page.locator('#mbg')).toHaveClass(/vis/,{timeout:4000});
      await expect(page.locator('#mdl-title')).toHaveText(bundle['modal.share']);
      const field=page.locator('#mdl textarea');url=await field.inputValue();
      await expect(field).toBeFocused();
      expect(await field.evaluate(el=>{const field=/** @type {HTMLTextAreaElement} */(el);return field.selectionEnd-field.selectionStart;})).toBe(url.length);
    }
    expect(url).toContain('#p=');
    await page.goto('about:blank');
    await page.goto(url);
    await expect(page.locator('#toast')).toHaveText(bundle['notify.project_loaded_from_link']);
    const pending=page.waitForEvent('download');await page.locator('[data-action="save"]').click();
    const stream=await (await pending).createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
    const saved=JSON.parse(Buffer.concat(chunks).toString());
    expect(JSON.stringify(saved)).not.toContain('private-pass');
    expect(saved.floors[0].CAMS.length).toBe(cameras?project.floors[0].CAMS.length:0);
    if(cameras)expect(saved.floors[0].CAMS.map(d=>d.name)).toEqual(project.floors[0].CAMS.map(d=>d.name));
    await testInfo.attach('browser-errors',{body:JSON.stringify(errors),contentType:'application/json'});
    expect(errors).toEqual([]);
  });
}

test('Share reports compression errors without unhandled promises',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{Object.defineProperty(window,'CompressionStream',{value:class{constructor(){throw new Error('Compression failed');}}});});
  await page.goto('/');await page.locator('[data-action="share-link"]').click();
  await expect(page.locator('#toast')).toContainText('Compression failed');expect(errors).toEqual([]);
});

test('Share without compression opens in a browser with decompression support',async({page,context})=>{
  await page.addInitScript(()=>{window['CompressionStream']=undefined;Object.defineProperty(navigator,'clipboard',{value:{writeText:async url=>{window['sharedUrl']=url;}}});});
  await page.goto('/');await page.locator('[data-action="share-link"]').click();
  await expect(page.locator('#toast')).toContainText('copied');
  const url=await page.evaluate(()=>window['sharedUrl']);const recipient=await context.newPage();
  await recipient.goto(url);await expect(recipient.locator('#toast')).toContainText('loaded from link');
});

test('Share catches stream write failures and leaves no rejected promises',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    Object.defineProperty(window,'CompressionStream',{value:class extends TransformStream{
      constructor(){super({transform(){throw new Error('Stream write failed');}});}
    }});
  });
  await page.goto('/');await page.locator('[data-action="share-link"]').click();
  await expect(page.locator('#toast')).toContainText(en['notify.share_failed']);
  // Give detached write/close rejections a chance to fire.
  await page.waitForTimeout(100);expect(errors).toEqual([]);
});

test('Share explains when the project exceeds the URL limit',async({page})=>{
  await page.addInitScript(()=>{Object.defineProperty(window,'CompressionStream',{value:undefined});});
  await page.goto('/');
  const project=buildSampleProject();project.settings.company='large'.repeat(2000);
  await page.locator('#load-up').setInputFiles({name:'large.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.cam-grp')).toHaveCount(project.floors[0].CAMS.length);
  await page.locator('[data-action="share-link"]').click();
  await expect(page.locator('#toast')).toHaveText(en['notify.project_too_large_for_a_url_use_save_instead']);
});
