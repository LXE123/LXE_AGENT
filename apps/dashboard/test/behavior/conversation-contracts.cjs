const assert = require('node:assert/strict');
module.exports = async ({suite,win,url,js,step,load,waitFor,click,key,focus,settle,state}) => {
  const textClick = async text => { await js(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent===${JSON.stringify(text)}).click()`); await settle(); };
  if (suite === 'conversation-window') {
    await step('long user messages fold by rendered height and keep the full text available', async () => {
      await win.loadURL(new URL('../features/sessions/process-fixture.html', url).href);
      const preview = "document.querySelector('.user-message-preview')";
      const toggle = '.user-message-toggle';
      await waitFor(`Boolean(${preview})`, 'user message');
      assert.equal(await js(`${preview}.parentElement.querySelector('button')`), null);
      await textClick('Complete');
      await textClick('Toggle long user');
      await textClick('Toggle narrow column');
      await waitFor(`Boolean(${preview}.dataset.truncated)`, 'wrapped message is collapsed');
      const fullText = await js(`${preview}.textContent`);
      const collapsedHeight = await js(`${preview}.clientHeight`);
      await js("Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async text=>{window.copiedText=text}} })");
      await click('.message-meta.role-user .message-meta-copy');
      assert.equal(await js('window.copiedText'), fullText);
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'`);
        assert.equal(await js(`getComputedStyle(${preview}.closest('.message-card.role-user')).borderWidth`), '0px');
        assert.match(await js(`getComputedStyle(${preview}).maskImage`), /linear-gradient/);
        await focus(toggle);
        await key('Enter');
        assert.equal(await js(`document.querySelector('${toggle}').getAttribute('aria-expanded')`), 'true');
        assert.ok(await js(`${preview}.clientHeight`) > collapsedHeight);
        assert.equal(await js(`getComputedStyle(${preview}).maskImage`), 'none');
        assert.ok(await js("Boolean(document.querySelector('.conversation-jump-latest'))"), 'reading suspends follow');
        await key('Enter');
        assert.equal(await js(`${preview}.clientHeight`), collapsedHeight);
      }
      await textClick('Toggle narrow column');
      await waitFor(`!document.querySelector('${toggle}')`, 'wider text fits without a toggle');
      await textClick('Toggle narrow column');
      await textClick('Toggle attachment');
      await waitFor(`Boolean(${preview}.dataset.truncated)`, 'attachment caption folds');
      assert.ok(await js(`!document.querySelector('.sent-attachments').closest('.user-message-preview')`));
    });
    await step('adjacent tool calls share an outline and expand independently', async () => {
      await win.loadURL(new URL('../features/sessions/process-fixture.html', url).href);
      const card = id => `[data-conversation-row="tool:t:${id}"] .tool-op-list`;
      await waitFor(`Boolean(document.querySelector('${card("c")}'))`, 'first tool');
      await js(`window.firstTool = document.querySelector('${card("c")}')`);
      await textClick('Append tool calls');
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'`);
        await settle();
        const [first, middle, last, separate] = await js(`[${['c','write','check','last'].map(id => JSON.stringify(card(id))).join(',')}].map(selector => {
          const el = document.querySelector(selector), style = getComputedStyle(el), rect = el.getBoundingClientRect();
          return {top: rect.top, bottom: rect.bottom, topRadius: parseFloat(style.borderTopLeftRadius),
            bottomRadius: parseFloat(style.borderBottomLeftRadius), topBorder: parseFloat(style.borderTopWidth), bottomBorder: parseFloat(style.borderBottomWidth)};
        })`);
        assert.ok(first.topRadius > 0 && last.bottomRadius > 0 && separate.topRadius > 0 && separate.bottomRadius > 0);
        assert.deepEqual([first.bottomRadius, middle.topRadius, middle.bottomRadius, last.topRadius], [0, 0, 0, 0]);
        for (const [above, below] of [[first, middle], [middle, last]]) {
          assert.ok(Math.abs(above.bottom - below.top) < 1, 'no gap between cards');
          assert.equal(above.bottomBorder + below.topBorder, 1, 'a single divider');
        }
      }
      await click(card('write') + ' .tool-op-summary');
      assert.equal(await js(`document.querySelector('${card("write")} .tool-op-summary').getAttribute('aria-expanded')`), 'true');
      assert.equal(await js(`firstTool === document.querySelector('${card("c")}') && firstTool.querySelector('button').getAttribute('aria-expanded') === 'false'`), true);
      assert.equal(await js(`document.querySelector('${card("check")} .tool-op-summary').getAttribute('aria-expanded')`), 'false');
      await textClick('Show thinking between calls');
      await js(`{ const transcript = document.querySelector('.conversation-transcript');
        transcript.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -600 }));
        transcript.scrollTop = 0; }`);
      await waitFor(`Boolean(document.querySelector('${card("c")}') && document.querySelector('${card("check")}'))`, 'tool cards around visible thinking');
      for (const id of ['c', 'write', 'check']) {
        assert.equal(await js(`document.querySelector('${card(id)}').closest('[data-conversation-row]').matches('[data-tool-joins-previous], [data-tool-joins-next]')`), false);
      }
      assert.equal(await js(`document.querySelector('[data-conversation-row="next:0"]').textContent`), 'Checking a detail.');
      assert.ok(await js(`document.querySelector('[data-conversation-row="next:4"] .redacted')?.textContent`));
      assert.equal(await js(`document.querySelector('${card("write")} .tool-op-summary').getAttribute('aria-expanded')`), 'true');
    });
    await step('compaction between tool cards has balanced spacing and uses secondary status text', async () => {
      await win.loadURL(new URL('../features/sessions/process-fixture.html?toolAnswer=compaction', url).href);
      await waitFor("document.querySelector('.conversation-compaction-marker') && document.querySelectorAll('.tool-op-list').length === 2", 'compaction between calls');
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'; document.fonts.ready`);
        await settle();
        const { before, after, color, statusColor } = await js(`(() => {
          const marker = document.querySelector('.conversation-compaction-marker');
          const range = document.createRange();
          range.selectNodeContents(marker.querySelector('span'));
          const text = range.getBoundingClientRect();
          const card = id => document.querySelector('[data-conversation-row="tool:t:' + id + '"] .tool-op-list').getBoundingClientRect();
          return { before: text.top - card('c').bottom, after: card('next-read').top - text.bottom,
            color: getComputedStyle(marker).color, statusColor: getComputedStyle(document.querySelector('.conversation-process-toggle')).color };
        })()`);
        assert.ok(Math.abs(before - 12) <= 2 && Math.abs(before - after) <= 2, `${theme}: visible gaps ${before}px / ${after}px`);
        assert.equal(color, statusColor, `${theme}: marker matches the process status`);
      }
    });
    await step('expanded tool card has matching gaps to the completed label and final answer', async () => {
      for (const mode of ['blank', 'direct']) {
        await win.loadURL(new URL('../features/sessions/process-fixture.html?toolAnswer=' + mode, url).href);
        await textClick('Complete');
        await click('.conversation-process-toggle');
        await waitFor("Boolean(document.querySelector('.tool-op-list') && document.querySelector('.response-final-answer'))", 'tool and answer');
        await settle();
        const gaps = await js(`(() => {
          function textBounds(selector) {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector(selector));
            return range.getBoundingClientRect();
          }
          const label = textBounds('.live-progress-label');
          const card = document.querySelector('.tool-op-list').getBoundingClientRect();
          const answer = textBounds('.response-final-answer p strong');
          return [card.top - label.bottom, answer.top - card.bottom];
        })()`);
        assert.ok(gaps[0] >= 17 && gaps[0] <= 21, `${mode}: keep the original space below the label, got ${gaps[0]}`);
        assert.ok(Math.abs(gaps[0] - gaps[1]) <= 2, `${mode}: visible tool card gaps ${gaps}`);
      }
    });
    await step('resize compensation and row positions agree before the same paint',async()=>{
      for(const theme of ['light','dark']){
        await win.loadURL(new URL('../features/sessions/window-fixture.html',url).href);
        await waitFor("Boolean(document.querySelector('[data-display-group=g999]'))",'latest rows');
        await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.fonts.ready`);
        await settle();
        await js(`{const e=document.querySelector('.conversation-transcript');e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-50}));e.scrollTop-=50;}`);
        await settle();
        // Give the virtualizer a forward direction without resuming bottom follow.
        await js("document.querySelector('.conversation-transcript').scrollTop+=1");await settle();
        const result=await js(`(async()=>{
          const root=document.querySelector('.conversation-transcript'),top=root.getBoundingClientRect().top;
          const rows=[...root.querySelectorAll('[data-conversation-row]')];
          const anchor=rows.find(e=>e.getBoundingClientRect().bottom>top);
          const previous=rows[rows.indexOf(anchor)-1];
          if(!previous)throw new Error('Missing a mounted row above the reading anchor');
          const initial=anchor.getBoundingClientRect().top-top,scroll=root.scrollTop,samples=[];
          const initialHeight=previous.getBoundingClientRect().height;
          let onSample;
          // The production observer queues its measurement into rAF. Sample after
          // it in that same frame: checking only the settled position misses a flash.
          const observer=new ResizeObserver(([entry])=>requestAnimationFrame(()=>{
            const height=entry.borderBoxSize[0].blockSize;
            samples.push({height,offset:anchor.getBoundingClientRect().top-top,scroll:root.scrollTop,connected:anchor.isConnected});
            onSample?.(height);
          }));
          const waitForHeight=expected=>new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>reject(new Error(document.documentElement.dataset.theme+
              ': missing resize sample for height '+expected+'; observed '+JSON.stringify(samples))),4000);
            onSample=height=>{
              if(Math.abs(height-expected)>0.01)return;
              clearTimeout(timeout);onSample=undefined;resolve();
            };
          });
          observer.observe(previous,{box:'border-box'});
          const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          const original=previous.style.paddingBottom,padding=parseFloat(getComputedStyle(previous).paddingBottom);
          // Cross the virtualizer's 150 ms scroll-end fallback between writes.
          // A slow renderer must also get to sample each size before we reverse it.
          try{
            await Promise.all([delay(200),waitForHeight(initialHeight)]);
            for(let i=0;i<8;i++){
              const delta=i%2?0:4;
              previous.style.paddingBottom=(padding+delta)+'px';
              await Promise.all([delay(155),waitForHeight(initialHeight+delta)]);
            }
            return {initial,scroll,samples};
          }finally{observer.disconnect();previous.style.paddingBottom=original;}
        })()`);
        assert.ok(result.samples.length>=9,`${theme}: measured every resize`);
        assert.ok(result.samples.some(s=>s.scroll===result.scroll+4),`${theme}: compensation actually ran`);
        assert.ok(result.samples.every(s=>s.connected&&Math.abs(s.offset-result.initial)<0.5),
          `${theme}: intermediate-frame reading displacement: ${JSON.stringify(result)}`);
      }
    });
    await step('streaming preserves earlier text while reading and follows the fully sized feed',async()=>{
      await win.loadURL(new URL('../features/sessions/window-fixture.html',url).href);
      await waitFor("Boolean(document.querySelector('[data-display-group=g999]'))",'latest answer');
      // Measure reading stability after font metrics and resize observers settle.
      // Otherwise startup reflow is counted as a streaming displacement.
      await js("document.fonts.ready.then(() => undefined)");await settle();
      await js(`{const e=document.querySelector('.conversation-transcript');e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-50}));e.scrollTop-=50;}`);await settle();
      const reading=await js(`(async()=>{
        const root=document.querySelector('.conversation-transcript'),row=root.querySelector('[data-display-group=g999]');
        const paragraph=row.querySelector('.message-markdown p'),top=paragraph.getBoundingClientRect().top,scroll=root.scrollTop;
        const samples=[],mutations=[],initialLength=row.textContent.length;
        const observer=new MutationObserver(records=>mutations.push(...records.map(record=>record.type)));
        observer.observe(paragraph,{subtree:true,characterData:true,childList:true});
        const append=[...document.querySelectorAll('button')].find(e=>e.textContent==='Stream text');
        try{
          for(let i=0;i<12;i++){
            append.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            samples.push({offset:paragraph.getBoundingClientRect().top-top,scroll:root.scrollTop-scroll,
              same:paragraph===row.querySelector('.message-markdown p'),connected:paragraph.isConnected});
          }
          return {samples,mutations,initialLength,length:row.textContent.length};
        }finally{observer.disconnect();}
      })()`);
      assert.ok(reading.length>reading.initialLength+1000,'stream actually appended text');
      assert.deepEqual(reading.mutations,[],'completed paragraph is not rewritten');
      assert.ok(reading.samples.every(s=>s.same&&s.connected&&Math.abs(s.offset)<0.5&&s.scroll===0),JSON.stringify(reading));
      await click('.conversation-jump-latest');
      await waitFor("(()=>{const e=document.querySelector('.conversation-transcript');return e.scrollHeight-e.scrollTop-e.clientHeight<=2})()",'following latest');
      const following = await js(`new Promise((resolve, reject) => {
        const root = document.querySelector('.conversation-transcript');
        const row = root.querySelector('[data-display-group=g999]');
        const append = [...document.querySelectorAll('button')].find(e => e.textContent === 'Stream text');
        const samples = [];
        let previousHeight = 0;
        const observer = new ResizeObserver(([entry]) => {
          const height = entry.borderBoxSize[0].blockSize;
          if (height <= previousHeight) return;
          previousHeight = height;
          requestAnimationFrame(() => {
            samples.push(root.scrollHeight - root.scrollTop - root.clientHeight);
            // Measure the baseline and each append before scheduling the next one.
            if (samples.length < 9) {
              append.click();
              return;
            }
            observer.disconnect();
            clearTimeout(deadline);
            resolve(samples);
          });
        });
        const deadline = setTimeout(() => {
          observer.disconnect();
          reject(new Error('Expected 9 distinct streaming heights, measured ' + samples.length));
        }, 8000);
        observer.observe(row, {box: 'border-box'});
      })`);
      assert.ok(following.every(distance=>Math.abs(distance)<=2),`bottom-follow gaps before paint: ${following}`);
    });
    await step('scrolling up past the top of a tool result releases stream following', async () => {
      await win.loadURL(new URL('../features/sessions/window-fixture.html', url).href);
      const tool = '[data-display-group=g997] .tool-op-summary';
      await waitFor(`Boolean(document.querySelector('${tool}'))`, 'tool mounted');
      await js(`document.querySelector('${tool}').click()`);
      const output = "document.querySelector('[data-display-group=g997] .tool-result-full')";
      await waitFor(`${output}?.scrollHeight > ${output}?.clientHeight`, 'long tool output');
      await js("document.fonts.ready.then(() => undefined)");
      await settle();
      const transcript = "document.querySelector('.conversation-transcript')";
      await waitFor(`${transcript}.scrollHeight - ${transcript}.clientHeight - ${transcript}.scrollTop <= 2`, 'expanded output measured at the latest bottom');
      win.webContents.focus();
      await js("new Promise(resolve => setTimeout(resolve, 250))");
      const point = await js(`(() => {
        const result = ${output}, box = result.getBoundingClientRect();
        const view = document.querySelector('.conversation-transcript').getBoundingClientRect();
        const x = Math.floor(box.left + box.width / 2);
        const y = Math.floor((Math.max(view.top, box.top) + Math.min(view.bottom, box.bottom)) / 2);
        result.scrollTop = 200;
        return {x, y, hitsOutput: result.contains(document.elementFromPoint(x, y))};
      })()`);
      assert.ok(point.hitsOutput, 'wheel lands inside expanded output');
      win.webContents.debugger.attach('1.3');
      const wheelUp = () => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -80
      });
      const reading = "Boolean(document.querySelector('.conversation-jump-latest'))";
      const bottom = await js(transcript + '.scrollTop');
      await wheelUp();
      await waitFor(`Math.abs(${output}.scrollTop - 120) <= 1`, 'inner result scrolls by the wheel delta');
      assert.equal(await js(reading), false, 'following stays enabled inside the result');
      assert.equal(await js(transcript + '.scrollTop'), bottom);
      await js(output + '.scrollTop = 0');
      await settle();
      await wheelUp();
      await waitFor(`${reading} && Math.abs(${transcript}.scrollTop - (${bottom} - 80)) <= 1`, 'transcript takes over the next wheel gesture');
      win.webContents.debugger.detach();
      const before = await js(transcript + '.scrollTop');
      const height = await js(transcript + '.scrollHeight');
      await textClick('Stream text');
      await waitFor(`${transcript}.scrollHeight > ${height}`, 'stream grew below the reader');
      assert.equal(await js(transcript + '.scrollTop'), before, 'stream preserves the reading position');
    });
    await win.loadURL(new URL('../features/sessions/window-fixture.html',url).href);
    await waitFor("document.querySelectorAll('[data-conversation-row]').length>0",'virtual conversation');
    await step('pending-to-persisted handoff retains the visible message node',async()=>{
      await textClick('Pending bubble');
      await waitFor("Boolean(document.querySelector('[data-conversation-row=\"user:handoff\"]'))",'optimistic bubble');
      await js(`window.pendingNode=document.querySelector('[data-conversation-row="user:handoff"]')`);
      await textClick('Persist bubble');
      assert.equal(await js("pendingNode===document.querySelector('[data-conversation-row=\"user:handoff\"]')"),true);
    });
    await step('scrolling loads history while preserving the reading anchor and a bounded DOM',async()=>{
      await focus('.conversation-transcript');
      await js("const e=document.querySelector('.conversation-transcript');e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-800}));e.scrollTop=0;e.dispatchEvent(new Event('scroll'))");
      await waitFor("JSON.parse(document.querySelector('#metrics').textContent).groups>10",'older page loaded');
      const counts=await js("({groups:JSON.parse(document.querySelector('#metrics').textContent).groups,mounted:document.querySelectorAll('[data-conversation-row]').length})");
      assert.ok(counts.mounted>0&&counts.mounted<100,'bounded mounted rows');
      await waitFor("JSON.parse(document.querySelector('#acceptance').textContent).anchorError!=null",'anchor measurement');
      const acceptance=await js("JSON.parse(document.querySelector('#acceptance').textContent)");
      assert.ok(acceptance.anchorError<3,'history preserves reading position: '+JSON.stringify(acceptance));
      const lateResize=await js(`(async()=>{
        const root=document.querySelector('.conversation-transcript');
        const anchor=[...root.querySelectorAll('[data-conversation-row]')].find(row=>row.dataset.conversationRow===JSON.parse(document.querySelector('#acceptance').textContent).anchor);
        const above=anchor?.previousElementSibling;
        if(!above)throw new Error('Missing mounted history row above the reading anchor');
        const offset=()=>anchor.getBoundingClientRect().top-root.getBoundingClientRect().top;
        const before=offset(),height=above.offsetHeight,original=above.style.paddingBottom;
        try{
          above.style.paddingBottom=(parseFloat(getComputedStyle(above).paddingBottom)+41)+'px';
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          return {growth:above.offsetHeight-height,drift:offset()-before};
        }finally{above.style.paddingBottom=original;}
      })()`);
      assert.equal(lateResize.growth,41,'exercise a late measurement above the reader');
      assert.ok(Math.abs(lateResize.drift)<3,'late history resize: '+JSON.stringify(lateResize));
      await click('.conversation-jump-latest');
      await waitFor("Boolean(document.querySelector('[data-display-group=g999]'))",'latest group restored');
    });
    await step('late history response cannot overwrite a newly selected session',async()=>{
      await textClick('Switch during history load');
      await waitFor("JSON.parse(document.querySelector('#query-result').textContent).actual==='race-second'",'new session loaded');
      await new Promise(resolve=>setTimeout(resolve,350));
      const result=await js("JSON.parse(document.querySelector('#query-result').textContent)");
      assert.equal(result.actual,'race-second'); assert.equal(result.oldest,'g990');
    });
    await step('opening historical runs before latest arrives pins the target until user scrolls',async()=>{
      win.setSize(1000,700);
      await win.loadURL(new URL('../features/sessions/window-fixture.html?run-history=1',url).href);
      await waitFor("Boolean(document.querySelector('#run-state'))",'run fixture');
      const read=()=>js("JSON.parse(document.querySelector('#run-state').textContent)");
      await textClick('Open short run'); await settle();
      assert.deepEqual(await read(),{older:0,newer:0,staleAccepted:false,following:false,connection:'detached'});
      assert.ok(await js("Boolean(document.querySelector('[data-display-group=g100]'))"));
      await textClick('Refresh latest'); await settle();
      assert.deepEqual(await read(),{older:0,newer:0,staleAccepted:false,following:false,connection:'detached'});
      await click('.conversation-jump-latest');
      await waitFor("JSON.parse(document.querySelector('#run-state').textContent).following",'explicit jump resumes following');
      assert.ok(await js("Boolean(document.querySelector('[data-display-group=g999]'))"));
      await textClick('Open long run'); await settle(); await settle();
      const offset=await js("document.querySelector('[data-display-group=g105]').getBoundingClientRect().top-document.querySelector('.conversation-transcript').getBoundingClientRect().top");
      assert.ok(Math.abs(offset)<3,`target run is anchored at the top: ${offset}`);
      assert.deepEqual(await read(),{older:0,newer:0,staleAccepted:false,following:false,connection:'detached'});
      await js("{const root=document.querySelector('.conversation-transcript');root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:800}));root.scrollTop=root.scrollHeight;root.dispatchEvent(new Event('scroll'))}");
      await waitFor("JSON.parse(document.querySelector('#run-state').textContent).newer>0",'user scroll enables pagination');
    });
    await step('paging follows scroll position when tall rows keep the virtual range unchanged',async()=>{
      for(const direction of ['older','newer']) {
        await win.loadURL(new URL(`../features/sessions/window-fixture.html?pagination=${direction}`,url).href);
        await waitFor("document.querySelectorAll('[data-conversation-row]').length>0",'long conversation rows');
        await settle(); await settle();
        // Leave follow mode before approaching the edge. Jumping directly to
        // zero in the same event, as older tests did, hides this regression.
        await js(`{
          const root=document.querySelector('.conversation-transcript');
          root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-40}));
          root.scrollTop=${direction==='older'?'300':'root.scrollHeight-root.clientHeight-300'};
          root.dispatchEvent(new Event('scroll'));
        }`);
        await settle(); await settle();
        await textClick('Enable paging');
        const before=await js("({range:[...document.querySelectorAll('[data-index]')].map(e=>e.dataset.index),requests:JSON.parse(document.querySelector('#pagination-metrics').textContent).requests,top:document.querySelector('.conversation-transcript').scrollTop,bottom:document.querySelector('.conversation-transcript').scrollHeight-document.querySelector('.conversation-transcript').clientHeight-document.querySelector('.conversation-transcript').scrollTop})");
        assert.equal(before.requests,0,`${direction}: no request outside the paging boundary`);
        assert.deepEqual(before.range,['0','1','2','3'],'both messages and their metadata are already mounted');
        assert.ok(before.top>120&&before.bottom>120,'test starts away from both paging boundaries');
        await js(`{
          const root=document.querySelector('.conversation-transcript');
          root.scrollTop=${direction==='older'?'0':'root.scrollHeight-root.clientHeight'};
          root.dispatchEvent(new Event('scroll'));
          window.boundaryRange=[...document.querySelectorAll('[data-index]')].map(e=>e.dataset.index);
        }`);
        assert.deepEqual(await js('boundaryRange'),before.range,'edge reached without changing the mounted rows');
        await waitFor("JSON.parse(document.querySelector('#pagination-metrics').textContent).loaded",`${direction} page loaded inside unchanged virtual range`);
        assert.equal(await js("JSON.parse(document.querySelector('#pagination-metrics').textContent).requests"),1,'one page request');
        assert.ok(await js(`Boolean(document.querySelector('[data-display-group="page-${direction==='older'?1:4}"]'))`),'returned page renders');
      }
    });
    await step('compaction stays between streamed content and scrolls normally in every theme',async()=>{
      const fixture=new URL('../features/sessions/window-fixture.html?compaction=1',url).href;
      await win.loadURL(fixture);
      await waitFor("Boolean(document.querySelector('.conversation-compaction-marker'))",'compaction marker');
      const ordered=async()=>assert.deepEqual(await js("Array.from(document.querySelectorAll('[data-conversation-row]')).map(e=>e.dataset.conversationRow).filter(id=>['a:0','compaction:compact','b:0'].includes(id))"),['a:0','compaction:compact','b:0']);
      await ordered();
      await js("window.markerNode=document.querySelector('.conversation-compaction-marker')");
      await textClick('Append after compaction');
      await ordered();
      assert.ok(await js("document.querySelector('[data-conversation-row=\"b:0\"]').textContent.includes('2 项检查')"));
      await textClick('Save compaction history');
      assert.ok(await js("markerNode===document.querySelector('.conversation-compaction-marker')"),'same DOM node through streaming and history handoff');
      await win.loadURL(fixture+'&saved=1');
      await waitFor("Boolean(document.querySelector('.conversation-compaction-marker'))",'refreshed marker');
      for(const [theme,width] of [['light',1000],['dark',1000],['light',380],['dark',380]]) {
        win.setSize(width,700);
        await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await settle();
        await ordered();
        const info=await js(`(() => {
          const marker=document.querySelector('.conversation-compaction-marker'), style=getComputedStyle(marker), rect=marker.getBoundingClientRect();
          return {count:document.querySelectorAll('.conversation-compaction-marker').length,text:marker.textContent,
            background:style.backgroundColor,border:style.borderTopWidth,position:style.position,controls:marker.querySelectorAll('button,a,input,summary').length,
            fits:rect.right<=innerWidth&&rect.left>=0,after:document.querySelector('[data-conversation-row="b:0"]').getBoundingClientRect().top>=rect.bottom};
        })()`);
        assert.equal(info.count,1); assert.equal(info.text,'已压缩上下文 · 255 条消息');
        assert.equal(info.background,'rgba(0, 0, 0, 0)'); assert.equal(info.border,'0px'); assert.equal(info.position,'static');
        assert.equal(info.controls,0); assert.ok(info.fits&&info.after);
        if(process.env.LXE_COMPACTION_SCREENSHOT) {
          await js('document.fonts.ready.then(()=>undefined)'); await settle();
          const rect=await js("document.querySelector('.conversation-transcript').getBoundingClientRect().toJSON()");
          require('node:fs').writeFileSync(process.env.LXE_COMPACTION_SCREENSHOT.replace(/\.png$/,`-${theme}-${width}.png`),
            (await win.webContents.capturePage({x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.floor(rect.width),height:Math.min(360,Math.floor(rect.height))})).toPNG());
        }
      }
      await textClick('Long answer');
      await js("{const root=document.querySelector('.conversation-transcript');root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-800}));root.scrollTop=0;root.dispatchEvent(new Event('scroll'))}"); await settle();
      const before=await js("document.querySelector('.conversation-compaction-marker').getBoundingClientRect().top");
      await js("{const root=document.querySelector('.conversation-transcript');root.scrollTop=60;root.dispatchEvent(new Event('scroll'))}"); await settle();
      const after=await js("document.querySelector('.conversation-compaction-marker').getBoundingClientRect().top");
      assert.ok(Math.abs(before-after-60)<3,'marker scrolls with content');
      const height=await js("document.querySelector('.conversation-transcript').scrollHeight");
      await textClick('Prepend compaction history');
      await waitFor(`document.querySelector('.conversation-transcript').scrollHeight>${height}`,'older history rendered');
      // Compare once row measurement has settled; slow machines need more than two frames.
      let afterPrepend,previous;
      for(let i=0;i<40&&afterPrepend!==previous||i<2;i++){previous=afterPrepend;await settle();afterPrepend=await js("document.querySelector('.conversation-compaction-marker').getBoundingClientRect().top");}
      assert.ok(Math.abs(afterPrepend-after)<3,`prepending preserves reading anchor: ${after} -> ${afterPrepend}`);
    });
    return;
  }
  await load('?contracts=1');
  await step('copy, code highlighting and wide tables preserve complete message content',async()=>{
    await js("behavior.mountContent();window.copiedText=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedText=text}}})");
    await settle();
    await click('[data-fixture-row=answer] .message-meta-copy');
    assert.ok((await js('copiedText')).includes('const answer = 42;'));
    await waitFor("document.querySelector('code .hljs-keyword')?.textContent==='const'", 'code highlighting completed');
    const table = await js("({text:document.querySelector('td:last-child').textContent,width:document.documentElement.scrollWidth,viewport:innerWidth})");
    assert.equal(table.text,'long-cell-'.repeat(80));
    assert.ok(table.width<=table.viewport+1,'table does not overflow the page');
    assert.equal(await js("document.querySelector('[data-fixture-row=answer] time').dateTime"),'1970-01-01T00:00:00.001Z');
  });
  await step('artifact open/reveal and attachment open send opaque IDs and keep actual failures',async()=>{
    const label = await js("document.querySelector('.turn-file-section').getAttribute('aria-label')");
    assert.match(label, /1$/);
    assert.ok(!(await js("document.querySelector('.turn-file-section').innerText")).includes(label));
    for (const theme of ['light', 'dark']) {
      const border = await js(`(() => {
        document.documentElement.dataset.theme = '${theme}';
        return getComputedStyle(document.querySelector('.turn-file-item')).borderWidth;
      })()`);
      assert.equal(border, '0px');
    }
    await js("document.documentElement.dataset.theme='light'");
    await js("behavior.ui.hold('sessions.file.open');behavior.ui.fail('sessions.file.open',true)");
    await click('.turn-file-card');
    assert.equal(await js("document.querySelector('.turn-file-card').disabled&&document.querySelector('.turn-file-reveal').disabled"),true);
    await js("behavior.ui.release('sessions.file.open')");
    await waitFor("document.querySelector('.turn-file-card-error')?.textContent.includes('EACCES: fixture sessions.file.open denied')",'file error');
    await js("behavior.ui.fail('sessions.file.open',false)");
    await click('.turn-file-card'); await click('.turn-file-reveal'); await click('.sent-file-card');
    const requests=(await state()).calls.filter(c=>c.operation.startsWith('sessions.file.')||c.operation==='sessions.attachment.open');
    assert.deepEqual(requests.map(c=>c.input),[
      {session_id:'content-session',artifact_id:'artifact-handle'}, {session_id:'content-session',artifact_id:'artifact-handle'},
      {session_id:'content-session',artifact_id:'artifact-handle'}, {session_id:'content-session',attachment_id:'attachment-handle'}]);
    assert.equal(await js("Boolean(document.querySelector('.turn-file-card-error'))"),false);
  });
  await step('running process ticks locally and expands through its accessible control',async()=>{
    const script = '[data-fixture-row="live-codemode"]';
    await click(script + ' .tool-op-summary');
    assert.match(await js(`document.querySelector('${script} .tool-call-args').textContent`), /Input arguments[\s\S]*orders\.csv/i);
    assert.equal(await js(`Boolean(document.querySelector('${script} .result-block'))`), false);
    await textClick('Finish fixture tool');
    assert.match(await js(`document.querySelector('${script} .tool-op-body').textContent`), /orders\.csv[\s\S]*order-123/);
    await click(script + ' .tool-op-summary');
    const before=await js("document.querySelector('.live-progress-elapsed').textContent");
    await click('[data-fixture-row=process] button');
    assert.equal(await js("document.querySelector('[data-fixture-row=process] button').getAttribute('aria-expanded')"),'true');
    await waitFor(`document.querySelector('.live-progress-elapsed').textContent!==${JSON.stringify(before)}`,'local elapsed time tick');
    assert.equal((await state()).calls.some(c=>c.operation==='sessions.activity'),false,'clock needs no polling request');
  });
  await step('model and thinking menus honor keyboard, pending writes and failure rollback',async()=>{
    await load('?app=1&workspaces=1&contracts=1&section=sessions');
    await waitFor("Boolean(document.querySelector('.conversation-compose-trailing .conversation-model-trigger'))",'model ready');
    await click('.conversation-compose-trailing .conversation-model-trigger'); await key('Escape');
    assert.equal(await js("document.activeElement.matches('.conversation-compose-trailing .conversation-model-trigger')"),true);
    await click('.conversation-compose-trailing .conversation-model-trigger');
    assert.equal(await js("Array.from(document.querySelectorAll('.conversation-model-option')).find(e=>e.textContent.includes('unavailable-model')).disabled"),true);
    const list = "document.querySelector('.conversation-model-options')";
    assert.ok(await js(`${list}.scrollHeight > ${list}.clientHeight`), 'long model list needs a scroll viewport');
    const point = await js(`(() => { const r=${list}.getBoundingClientRect();return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
    // A wheel sent while the popover is still settling can be dropped on slow machines.
    for (let i = 0; i < 20 && !await js(`${list}.scrollTop > 0`); i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -1800, canScroll: true });
      await settle();
    }
    assert.ok(await js(`${list}.scrollTop > 0`), 'native wheel scrolls the model list');
    const atEnd = `${list}.lastElementChild.getBoundingClientRect().bottom <= ${list}.getBoundingClientRect().bottom + 1`;
    for (let i = 0; i < 20 && !await js(atEnd); i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -500, canScroll: true });
      await settle();
    }
    assert.ok(await js(atEnd), 'last model is reachable with the wheel');
    await js("behavior.ui.hold('models.update');behavior.ui.fail('models.update',true)");
    await js("Array.from(document.querySelectorAll('.conversation-model-option')).find(e=>e.textContent.includes('next-model')).click()"); await settle();
    await waitFor("document.querySelector('.conversation-compose-trailing .conversation-model-trigger').textContent.includes('next-model')",'optimistic model');
    await js("behavior.ui.release('models.update')");
    await waitFor("document.querySelector('.conversation-compose-trailing .conversation-model-trigger').textContent.includes('fixture-model')",'model rollback');
    assert.ok(await js("document.body.textContent.includes('EACCES: fixture models.update denied')"));
    await click('.conversation-thinking-trigger');
    await focus('.conversation-thinking-help');
    await waitFor("getComputedStyle(document.querySelector('.conversation-thinking-tooltip')).opacity === '1'", 'focused help shows the effort description');
    assert.ok(await js(`document.querySelector('.conversation-thinking-help').ariaDescribedByElements[0]
      === document.querySelector('.conversation-thinking-tooltip')`), 'effort help has an accessible description');
    const thumbColors = [];
    for (const theme of ['dark', 'light']) {
      const colors = await js(`(() => {
        document.documentElement.dataset.theme = '${theme}';
        const menu = document.querySelector('.conversation-thinking-menu');
        const tooltip = menu.querySelector('[role="tooltip"]');
        return {
          thumb: getComputedStyle(menu.querySelector('.conversation-thinking-knob')).backgroundColor,
          track: getComputedStyle(menu.querySelector('.conversation-thinking-levels')).backgroundColor,
          separated: tooltip.getBoundingClientRect().bottom < menu.getBoundingClientRect().top,
        };
      })()`);
      thumbColors.push(colors.thumb);
      assert.notEqual(colors.thumb, colors.track, theme + ' thumb stands out from the track');
      assert.ok(colors.separated, theme + ' tooltip leaves the panel edge visible');
    }
    assert.notEqual(thumbColors[0], thumbColors[1], 'thumb adapts to the theme');
    await js("behavior.ui.hold('models.thinking.update');behavior.ui.fail('models.thinking.update',true)");
    await click('.conversation-thinking-level:last-of-type');
    assert.equal(await js("Array.from(document.querySelectorAll('.conversation-thinking-level')).every(e=>e.disabled)"),true);
    await js("behavior.ui.release('models.thinking.update')");
    await waitFor("document.querySelectorAll('.conversation-thinking-level')[1].getAttribute('aria-checked')==='true'",'thinking rollback');
    await js("behavior.ui.fail('models.thinking.update',false)");
    await focus('.conversation-thinking-level:last-of-type'); await key('Enter');
    await waitFor("document.querySelector('.conversation-thinking-level:last-of-type').getAttribute('aria-checked')==='true'",'keyboard thinking selection');
    assert.deepEqual((await state()).calls.filter(c=>c.operation==='models.thinking.update').map(c=>c.input),[
      {level:'high',session_id:'Default chat',selection_version:0},
      {level:'high',session_id:'Default chat',selection_version:0},
    ]);
  });
  await step('message context menus stage, preview and remove quotes without editing the draft', async () => {
    await load('?app=1&workspaces=1&section=sessions&forkFixture=1');
    const session = '[data-session-id="Default chat"] .session-index-open';
    await waitFor(`!!document.querySelector(${JSON.stringify(session)})`, 'conversation available');
    await click(session);
    const body = '.response-final-answer .message-markdown p';
    await waitFor(`document.querySelector(${JSON.stringify(body)})?.textContent === 'assistant one'`, 'first answer');
    const editor = '.reference-editor';
    await focus(editor);
    await win.webContents.insertText('existing draft');
    await settle();
    await js(`Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async text=>{window.copied=text} } });
      window.lxe.desktop.showConversationLinkMenu = async request => {
        window.menuRequest = request;
        getSelection().removeAllRanges();
        return window.menuAction;
      }; void 0;`);
    const menu = async (selector, action, selected = false) => {
      assert.equal(await js(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const range = document.createRange();
        if (${selected}) {
          range.setStart(element.firstChild, 0);
          range.setEnd(element.firstChild, 9);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        }
        const rect = (${selected} ? range : element).getBoundingClientRect();
        window.menuAction = ${JSON.stringify(action)};
        return !element.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2,
          clientX:rect.left + 3, clientY:rect.top + rect.height/2}));
      })()`), true);
      await settle();
    };
    await menu('.user-reference-text', 'copy-message');
    assert.equal(await js("window.copied"), "user one");
    await menu(body, 'copy-message');
    assert.equal(await js("window.copied"), "assistant one");
    assert.equal(await js("menuRequest.kind"), "message");
    await menu(body, 'copy-selection', true);
    assert.equal(await js("window.copied"), "assistant");
    assert.equal(await js("menuRequest.selection"), "copy-and-quote");
    await menu(body, 'quote-selection', true);
    const draft = "sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session)";
    assert.equal(await js(draft), 'existing draft');
    assert.equal(await js("document.activeElement.matches('.reference-editor')"), true);
    await click('.composer-quotes .message-quote-open');
    await waitFor("document.querySelector('.quote-preview blockquote')?.textContent === 'assistant'", 'quote preview');
    await key('Escape');
    assert.equal(await js("!!document.querySelector('.composer-quotes')"), true);
    await click('.composer-quotes .quote-icon');
    assert.equal(await js("!!document.querySelector('.composer-quotes')"), false);
    assert.equal(await js(draft), 'existing draft');
    await win.webContents.insertText('x'.repeat(8192 - (await js(draft)).length));
    await settle();
    const fullDraft = await js(draft);
    assert.equal(fullDraft.length, 8192);
    assert.ok(fullDraft.includes('existing draft'));
    await menu(body, 'quote-selection', true);
    await waitFor("document.querySelector('.conversation-compose-error')?.textContent.includes('8192')", 'quote exceeds draft limit');
    assert.equal(await js(draft), fullDraft);
    await menu(body, 'fork');
    await waitFor("document.querySelector('.conversation-header h2')?.textContent === 'Default chat(1)'", 'fork from reply body');
    assert.deepEqual((await state()).calls.filter(c=>c.operation==='sessions.fork').at(-1).input, { session_id:'Default chat', turn_id:'one' });
    assert.equal(await js("document.querySelector('.reference-editor').textContent"), "");
  });
  await step('selection quotes keep comments separate from the draft until confirmed and sent', async () => {
    await load('?app=1&workspaces=1&section=sessions&forkFixture=1&quoteHistory=1');
    const shopToggle = '[data-workspace-directory="/fixture/shop"] .workspace-group-toggle';
    const wasExpanded = await js(`document.querySelector('${shopToggle}').getAttribute('aria-expanded') === 'true'`);
    if (!wasExpanded) await click(shopToggle);
    await click('[data-session-id="Shop chat 2"] .session-index-open');
    await waitFor("document.querySelector('.response-final-answer .message-markdown p')?.textContent === 'assistant one'", 'shop conversation ready');
    const body = '.response-final-answer .message-markdown p';
    const card = '.selection-quote-card';
    const field = card + ' textarea';
    const select = async () => {
      await js(`(() => {
        const element = document.querySelector('${body}');
        element.scrollIntoView({block:'center'});
        const r = document.createRange(); r.selectNodeContents(element);
        getSelection().removeAllRanges(); getSelection().addRange(r);
      })()`);
      await waitFor("!!document.querySelector('.quote-trigger')", 'selection quote action');
      const point = await js(`(() => { const r = document.querySelector('.quote-trigger').getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await waitFor(`document.activeElement.matches('${field}')`, 'comment editor focused');
    };
    const outside = () => js("document.querySelector('.conversation-body').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0}))");
    await focus('.reference-editor');
    await win.webContents.insertText('my draft');
    await settle();
    await select();
    await outside(); await settle();
    assert.equal(await js(`!!document.querySelector('${card}')`), false);
    await select();
    const fieldHeight = () => js(`document.querySelector('${field}').clientHeight`);
    const initialHeight = await fieldHeight();
    assert.equal(await js(`document.querySelector('${card} blockquote').textContent`), 'assistant one');
    assert.equal(await js("CSS.highlights.get('lxe-quote-source').values().next().value.toString()"), 'assistant one');
    assert.ok(await js(`document.querySelector('${card}').getBoundingClientRect().height <= 70`), 'short excerpt and empty editor stay compact');
    await win.webContents.insertText('line\n'.repeat(3));
    await settle();
    assert.ok(await fieldHeight() > initialHeight, 'multiline comments expand the editor');
    await win.webContents.insertText('line\n'.repeat(20));
    await waitFor(`document.querySelector('${field}').scrollHeight > document.querySelector('${field}').clientHeight`, 'long comment scrolls inside the editor');
    await click(card + ' .quote-icon');
    assert.equal(await js(`!!document.querySelector('${card}')`), false);
    assert.equal(await js("CSS.highlights.has('lxe-quote-source')"), false);
    await select();
    await win.webContents.insertText('unconfirmed');
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}))`);
    assert.equal(await js(`document.querySelector('${field}').value`), 'unconfirmed');
    await key('Escape');
    assert.equal(await js(`!!document.querySelector('${card}')`), false);
    assert.equal(await js("document.querySelector('.reference-editor').textContent"), 'my draft');
    await select();
    assert.equal(await js(`document.querySelector('${field}').value`), '');
    await win.webContents.insertText('why?');
    await outside(); await settle();
    assert.equal(await js(`document.querySelector('${field}').value`), 'why?');
    await click('.quote-confirm');
    await click('[data-session-id="Default chat"] .session-index-open');
    await waitFor("!document.querySelector('.composer-quotes')", 'quotes are scoped to their conversation');
    await load('?app=1&workspaces=1&section=sessions&forkFixture=1&quoteHistory=1');
    await waitFor(`!!document.querySelector('[data-session-id="Shop chat 2"] .session-index-open')`, 'shop chat restored');
    await click('[data-session-id="Shop chat 2"] .session-index-open');
    await waitFor("document.querySelector('.reference-editor')?.textContent === 'my draft' && !!document.querySelector('.composer-quotes .message-quote-open')", 'draft and quote restored after reload');
    await click('.composer-quotes .message-quote-open');
    assert.equal(await js("document.querySelector('.quote-preview blockquote').textContent"), 'assistant one');
    assert.equal(await js("document.querySelector('.quote-preview p').textContent"), 'why?');
    await key('Escape');
    await select();
    await click('.quote-confirm'); // No comment stages an ordinary excerpt.
    const bubble = '.message-card.role-user:has(.sent-message-quotes)';
    const checkBubble = async () => {
      await waitFor(`document.querySelector('${bubble} .user-reference-text')?.textContent === 'my draft'`, 'reader-facing message body');
      assert.equal(await js(`document.querySelector('${bubble}').textContent.includes('<!--')`), false);
      assert.equal(await js(`document.querySelectorAll('${bubble} .quote-icon').length`), 0);
      for (const [index, comment] of [[1, 'why?'], [2, '']]) {
        await click(`${bubble} .message-quote-row:nth-child(${index}) .message-quote-open`);
        assert.equal(await js("document.querySelector('.quote-preview blockquote').textContent"), 'assistant one');
        assert.equal(await js("document.querySelector('.quote-preview p')?.textContent ?? ''"), comment);
        await key('Escape');
      }
    };
    await js("behavior.failWorkspaceSend(true)");
    await click('.conversation-send-button');
    await waitFor("document.querySelector('.conversation-compose-error')?.textContent.includes('EACCES')", 'send error');
    assert.equal(await js("document.querySelector('.reference-editor').textContent"), 'my draft');
    assert.equal(await js("!!document.querySelector('.composer-quotes')"), true);
    await js("behavior.failWorkspaceSend(false);behavior.holdWorkspaceSend(true)");
    await click('.conversation-send-button');
    await checkBubble();
    await js("behavior.releaseWorkspaceSend()");
    await waitFor("!document.querySelector('.composer-quotes') && !document.querySelector('.reference-editor').textContent", 'sent quotes clear');
    assert.equal((await state()).calls.findLast(c=>c.operation==='sessions.send').input.text, '<!-- reply 1 -->\n> assistant one\n\nwhy?\n\n\n<!-- attach -->\n> assistant one\n\nmy draft');
    await load('?app=1&workspaces=1&section=sessions&forkFixture=1&quoteHistory=1');
    await click('[data-session-id="Shop chat 2"] .session-index-open');
    await checkBubble();
    await click('[data-session-id="Default chat"] .session-index-open');
    if (!wasExpanded) await click(shopToggle);
  });
  await step('assistant Markdown links open in the originating session file sidebar', async () => {
    await load('?app=1&workspaces=1&section=sessions&fileLinks=1');
    const report = '.conversation-feed .markdown-file-link[title="reports/测试 report.md"]';
    const website = '.conversation-feed .message-markdown a[href="https://example.com/docs"]';
    const shopToggle = '[data-workspace-directory="/fixture/shop"] .workspace-group-toggle';
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(shopToggle)}))`, 'shop workspace');
    await click(shopToggle);
    for (const session of ['Default chat', 'Shop chat 1']) {
      const row = `[data-session-id="${session}"] .session-index-open`;
      await waitFor(`Boolean(document.querySelector(${JSON.stringify(row)}))`, 'session in sidebar');
      await click(row);
      await waitFor(`document.querySelector('.conversation-header h2')?.textContent === ${JSON.stringify(session)} && Boolean(document.querySelector(${JSON.stringify(report)}))`, 'report link in selected chat');
      if (session === 'Default chat') {
        async function checkHover(selector, theme) {
          const element = `document.querySelector(${JSON.stringify(selector)})`;
          const colors = () => js(`((s) => [s.color, s.textDecorationColor])(getComputedStyle(${element}))`);
          await js(`${element}.scrollIntoView({ block: 'center' })`);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
          await settle();
          const [text, underline] = await colors();
          assert.notEqual(underline, text);
          // The link can wrap; aim at its first line box.
          const point = await js(`((r) => ({x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}))(${element}.getClientRects()[0])`);
          assert.ok(await js(`${element}.contains(document.elementFromPoint(${point.x}, ${point.y}))`), `${theme} ${selector} is visible`);
          win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          await waitFor(`${element}.matches(':hover')`, `${theme} ${selector} hover`);
          assert.deepEqual(await colors(), [text, text], `${theme} ${selector} hover colors`);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
          await settle();
          assert.deepEqual(await colors(), [text, underline]);
          return [text, underline];
        }
        for (const theme of ['dark', 'light']) {
          // Release follow mode so both links can scroll into view.
          await js(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};
            document.querySelector('.conversation-transcript').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }))`);
          const fileColors = await checkHover(report, theme);
          assert.deepEqual(await checkHover(website, theme), fileColors);
        }
      }
      await focus(report);
      await key('Enter');
      await waitFor(`document.querySelector('.file-sidebar .file-markdown h1')?.textContent === ${JSON.stringify('Report from ' + session)}`, 'report from the selected workspace');
      assert.ok((await state()).calls.some(call => call.operation === 'prepare' && call.input.ref.kind === 'workspace'
        && call.input.ref.path === 'reports/测试 report.md' && call.input.ref.session_id === session));
      await click(report);
      assert.equal(await js("document.querySelectorAll('.file-tab [role=tab]').length"), 1);
    }
    await click('.conversation-feed .markdown-file-link[title="missing.txt"]');
    await waitFor("!!document.querySelector('.file-sidebar .file-failure-panel')", 'missing file feedback in sidebar');
    const link = line => `.conversation-feed .markdown-file-link[title="scripts/source.ts:${line}"]`;
    for (const line of [42, 50, 42, 6500]) {
      await click(link(line));
      await waitFor(`(() => {
        const row = document.querySelector('.file-sidebar .file-target-line[data-line="${line}"]');
        const viewport = row?.closest('.file-text-scroll')?.getBoundingClientRect();
        return row?.textContent === '// source line ${line}' && row.getBoundingClientRect().top >= viewport.top && row.getBoundingClientRect().bottom <= viewport.bottom;
      })()`, 'visible source line ' + line);
    }
    assert.equal(await js("Array.from(document.querySelectorAll('.file-tab [role=tab]')).filter(tab => tab.textContent.includes('source.ts')).length"), 1);
    await click('.file-text-actions button:first-of-type');
    await waitFor("!!document.querySelector('.file-sidebar .code-line[data-line=\"1\"]')", 'return to beginning of distant source link');
    await click(link(9999));
    await waitFor("!!document.querySelector('.file-sidebar .file-line-missing')", 'line past end of file');
    const menu = async (selector, action) => js(`(() => {
      window.lxe.desktop.showConversationLinkMenu = async request => { window.lastLinkMenu = request; return ${JSON.stringify(action)}; };
      const link = document.querySelector(${JSON.stringify(selector)});
      return !link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    })()`);
    assert.equal(await menu('.conversation-feed .markdown-file-link[data-linked-path="/fixture/shared/reference.ts"]', 'preview'), true);
    assert.deepEqual(await js("lastLinkMenu.ref"), { kind: 'linked', session_id: 'Shop chat 1', path: '/fixture/shared/reference.ts' });
    await waitFor("document.querySelectorAll('.file-sidebar .file-target-line').length === 9", 'external file source range');
    assert.deepEqual(await js("Array.from(document.querySelectorAll('.file-sidebar .file-target-line'), row => Number(row.dataset.line))"),
      [42, 43, 44, 45, 46, 47, 48, 49, 50]);
    assert.ok((await state()).calls.some(call => call.operation === 'prepare' && call.input.ref.kind === 'linked'
      && call.input.ref.path === '/fixture/shared/reference.ts' && call.input.ref.session_id === 'Shop chat 1'));

    await js(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } });
      let live;
      window.lxe.tools = { subscribe: () => () => {}, call: async ({operation, input}) => {
        if (operation === 'browser.create') return live ??= { ...input, mountSrc: 'about:blank#menu-test', title: 'Docs' };
        if (operation === 'browser.get') return live;
        if (operation === 'browser.visible') return true;
      } }; void 0;`);
    assert.equal(await menu(website, 'copy-message'), true);
    await waitFor("window.copied?.includes('[查看完整分析]')", 'copy the whole reply from the website menu');
    assert.equal(await js("lastLinkMenu.fork"), true);
    assert.equal(await menu(website, 'sidebar'), true);
    await waitFor("!!document.querySelector('.sidebar-browser-frame:not([hidden])')", 'open website in an active browser tab');
    assert.equal(await js("document.querySelector('.tool-browser-restore') === null"), true);
    assert.equal(await js("JSON.parse(localStorage.getItem('lxe.file-preview.v1.Shop chat 1')).tabs.find(t => t.kind === 'browser').url"), 'https://example.com/docs');
    assert.equal(await menu(website, 'fork'), true);
    await waitFor("document.querySelector('.conversation-header h2')?.textContent === 'Default chat(1)'", 'fork from the linked reply');
    assert.deepEqual((await state()).calls.filter(call => call.operation === 'sessions.fork').at(-1).input, { session_id: 'Shop chat 1', turn_id: 'one' });
  });
};
