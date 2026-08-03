/*
  Comparador de preços V4 — matriz visual com 3 fornecedores, comparação parcial e PDF.
  Regra central: nenhum dado lido por IA entra na comparação antes da confirmação humana.
*/
(function(){
  'use strict';

  const Comparator = {
    STORAGE_KEY: 'sos_comparador_precos_v4',
    LEGACY_KEYS: ['sos_comparador_precos_v3','sos_comparador_precos_v2','sos_comparador_precos_v1'],
    state: {
      version: 4,
      vehicle: '',
      requestText: '',
      requested: [],
      suppliers: []
    },
    busySuppliers: new Set(),
    imagePreviews: {},
    lastComparisonPdfBlob: null,

    app(){
      try { return (typeof App !== 'undefined') ? App : null; }
      catch(e){ return null; }
    },
    $(id){ return document.getElementById(id); },
    id(prefix='id'){
      if(window.crypto && crypto.randomUUID) return prefix+'_'+crypto.randomUUID().replace(/-/g,'').slice(0,14);
      return prefix+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    },
    esc(value){
      return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
    },
    attr(value){ return this.esc(value).replace(/`/g,'&#96;'); },
    plain(value){
      return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();
    },
    clean(value){ return String(value ?? '').replace(/^[\s\-–—•*]+/,'').replace(/\s+/g,' ').trim(); },
    num(value){
      const app=this.app();
      if(app && typeof app.num==='function') return app.num(value);
      if(typeof value==='number') return Number.isFinite(value)?value:0;
      let x=String(value ?? '').trim().replace(/[^\d,.-]/g,'');
      if(!x) return 0;
      const comma=x.lastIndexOf(','),dot=x.lastIndexOf('.');
      if(comma>-1 && dot>-1) x=comma>dot?x.replace(/\./g,'').replace(',','.'):x.replace(/,/g,'');
      else if(comma>-1) x=x.replace(',','.');
      else if(dot>-1){ const p=x.split('.'); if(p.length>2 || p[p.length-1].length===3) x=x.replace(/\./g,''); }
      return Number(x)||0;
    },
    money(value){
      const app=this.app();
      if(app && typeof app.money==='function') return app.money(value);
      return (Number(value)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
    },
    toast(message){
      const app=this.app();
      if(app && typeof app.toast==='function') app.toast(message);
      else {
        const box=this.$('compareInlineMessage');
        if(box){ box.textContent=message; box.classList.add('show'); clearTimeout(this._msgTimer); this._msgTimer=setTimeout(()=>box.classList.remove('show'),5000); }
        else console.warn(message);
      }
    },
    confirm(message){ return window.confirm(message); },

    defaultState(){ return {version:4,vehicle:'',requestText:'',requested:[],suppliers:[]}; },
    save(){
      try { localStorage.setItem(this.STORAGE_KEY,JSON.stringify(this.state)); }
      catch(e){ console.warn('Falha ao salvar comparação',e); }
      const status=this.$('compareSaveStatus');
      if(status) status.textContent='Salvo neste navegador';
    },
    load(){
      try{
        let raw=localStorage.getItem(this.STORAGE_KEY);
        if(!raw){
          for(const key of this.LEGACY_KEYS){
            raw=localStorage.getItem(key);
            if(raw) break;
          }
        }
        if(!raw) return;
        const parsed=JSON.parse(raw);
        this.state=Object.assign(this.defaultState(),parsed||{}, {version:4});
        if(!Array.isArray(this.state.requested)) this.state.requested=[];
        if(!Array.isArray(this.state.suppliers)) this.state.suppliers=[];
        this.state.suppliers.forEach(s=>{
          s.draftOffers=Array.isArray(s.draftOffers)?s.draftOffers:[];
          s.offers=Array.isArray(s.offers)?s.offers:[];
          s.confirmed=!!s.confirmed;
          s.draftOffers=s.draftOffers.map(o=>this.normalizeDraft(o));
          s.offers=s.offers.map(o=>this.normalizeDraft(o));
        });
      }catch(e){
        console.warn('Falha ao carregar comparação',e);
        this.state=this.defaultState();
      }
    },
    init(){
      if(!this.$('secComparador')) return;
      this.load();
      this.ensureThreeSuppliers();
      this.$('compareVehicle').value=this.state.vehicle||'';
      this.$('compareRequestText').value=this.state.requestText||'';
      this.$('compareVehicle').addEventListener('input',()=>{this.state.vehicle=this.$('compareVehicle').value;this.save();});
      this.$('compareRequestText').addEventListener('input',()=>{this.state.requestText=this.$('compareRequestText').value;this.save();});
      this.renderAll();
    },
    renderAll(){
      this.ensureThreeSuppliers();
      this.renderRequested();
      this.renderSuppliers();
      this.renderResults();
      this.save();
    },
    newSupplier(index){
      return {
        id:this.id('sup'),name:`FORNECEDOR ${index}`,freight:0,responseText:'',imageName:'',imagePreview:'',documentTotal:0,documentExtra:0,
        draftOffers:[],offers:[],confirmed:false,confirmedAt:''
      };
    },
    ensureThreeSuppliers(){
      if(!Array.isArray(this.state.suppliers)) this.state.suppliers=[];
      while(this.state.suppliers.length<3) this.state.suppliers.push(this.newSupplier(this.state.suppliers.length+1));
      if(this.state.suppliers.length>3) this.state.suppliers=this.state.suppliers.slice(0,3);
      this.state.suppliers.forEach((s,index)=>{
        if(!s.id) s.id=this.id('sup');
        if(!String(s.name||'').trim()) s.name=`FORNECEDOR ${index+1}`;
        s.draftOffers=Array.isArray(s.draftOffers)?s.draftOffers:[];
        s.offers=Array.isArray(s.offers)?s.offers:[];
      });
    },

    wordsToNumber(value){
      const p=this.plain(value);
      const map={UM:1,UMA:1,DOIS:2,DUAS:2,PAR:2,TRES:3,QUATRO:4,CINCO:5,SEIS:6,SETE:7,OITO:8,NOVE:9,DEZ:10};
      const first=p.split(' ')[0];
      if(map[first]) return map[first];
      const m=String(value||'').match(/^\s*(\d+(?:[.,]\d+)?)/);
      return m?this.num(m[1]):0;
    },
    looksLikeVehicle(line){
      return /\b(?:19|20)\d{2}\b/.test(line) || /\b(UNO|GOL|PALIO|CORSA|FIAT|VOLKSWAGEN|VW|FORD|CHEVROLET|RENAULT|HONDA|TOYOTA|WAY)\b/i.test(line);
    },
    parseRequest(){
      const text=String(this.$('compareRequestText')?.value||'').trim();
      if(!text){ this.toast('Cole a lista de peças antes de continuar.'); return; }
      this.state.requestText=text;
      const rawLines=text.split(/\r?\n|;/).map(x=>this.clean(x)).filter(Boolean);
      const requested=[];
      rawLines.forEach((line,index)=>{
        let current=line.replace(/^[\-–—•*]+\s*/,'').trim();
        if(!current) return;
        const beginsQty=/^(?:\d+(?:[.,]\d+)?|UM|UMA|DOIS|DUAS|PAR|TRES|TRÊS|QUATRO|CINCO|SEIS|SETE|OITO|NOVE|DEZ)\b/i.test(current);
        if(index===0 && !beginsQty && this.looksLikeVehicle(current)){
          if(!this.state.vehicle) this.state.vehicle=current;
          return;
        }
        const qty=this.wordsToNumber(current)||1;
        current=current.replace(/^(?:\d+(?:[.,]\d+)?|UM|UMA|DOIS|DUAS|PAR|TRES|TRÊS|QUATRO|CINCO|SEIS|SETE|OITO|NOVE|DEZ)\s+/i,'').trim();
        if(!current) return;
        requested.push({id:this.id('req'),order:requested.length,description:current,qty,unit:'PC'});
      });
      if(!requested.length){ this.toast('Nenhuma peça foi identificada na lista.'); return; }
      this.state.requested=requested;
      this.$('compareVehicle').value=this.state.vehicle||'';
      this.state.suppliers.forEach(s=>{
        s.confirmed=false;
        s.offers=[];
        (s.draftOffers||[]).forEach((o,i)=>o.requestedId=this.suggestRequestedId(o,i,s.draftOffers.length));
      });
      this.renderAll();
      this.toast(`${requested.length} item(ns) carregado(s).`);
    },
    loadBudgetParts(){
      const app=this.app();
      const parts=app?.state?.parts;
      if(!Array.isArray(parts)||!parts.length){ this.toast('O orçamento atual não possui peças.'); return; }
      if(this.state.requested.length && !this.confirm('Substituir a lista atual pelas peças do orçamento?')) return;
      this.state.requested=parts.map((p,i)=>({id:this.id('req'),order:i,description:p.descricao||p.description||'PEÇA',qty:this.num(p.qtd)||1,unit:'PC'}));
      this.state.requestText=this.state.requested.map(r=>`${r.qty} ${r.description}`).join('\n');
      this.$('compareRequestText').value=this.state.requestText;
      const vehicle=app.$?.('veiculo')?.value||'';
      if(vehicle){this.state.vehicle=vehicle;this.$('compareVehicle').value=vehicle;}
      this.state.suppliers.forEach(s=>{s.confirmed=false;s.offers=[];});
      this.renderAll();
      this.toast('Peças do orçamento carregadas.');
    },
    addRequested(){
      this.state.requested.push({id:this.id('req'),order:this.state.requested.length,description:'',qty:1,unit:'PC'});
      this.renderAll();
    },
    updateRequested(id,field,value){
      const r=this.state.requested.find(x=>x.id===id); if(!r)return;
      r[field]=field==='qty'?Math.max(0.01,this.num(value)):value;
      this.state.suppliers.forEach(s=>{s.confirmed=false;s.offers=[];});
      this.renderResults();this.save();
    },
    removeRequested(id){
      const index=this.state.requested.findIndex(x=>x.id===id);if(index<0)return;
      this.state.requested.splice(index,1);
      this.state.requested.forEach((r,i)=>r.order=i);
      this.state.suppliers.forEach(s=>{
        s.draftOffers=(s.draftOffers||[]).map(o=>o.requestedId===id?{...o,requestedId:''}:o);
        s.offers=[];s.confirmed=false;
      });
      this.renderAll();
    },
    renderRequested(){
      const box=this.$('compareRequestedList'); if(!box)return;
      if(!this.state.requested.length){
        box.innerHTML='<div class="compare-empty">Cole a lista e toque em <b>Carregar peças</b>.</div>';
        return;
      }
      box.innerHTML=this.state.requested.map((r,i)=>`<div class="compare-request-card">
        <div class="compare-request-number">${i+1}</div>
        <div class="compare-request-fields">
          <div><label>Peça solicitada</label><input value="${this.attr(r.description)}" oninput="Comparator.updateRequested('${r.id}','description',this.value)"></div>
          <div><label>Quantidade</label><input inputmode="decimal" value="${this.attr(r.qty)}" oninput="Comparator.updateRequested('${r.id}','qty',this.value)"></div>
        </div>
        <button class="btn bad small compare-remove" onclick="Comparator.removeRequested('${r.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
      </div>`).join('');
    },

    addSupplier(){
      this.ensureThreeSuppliers();
      this.toast('A comparação foi organizada para exatamente 3 fornecedores.');
    },
    supplier(id){ return this.state.suppliers.find(s=>s.id===id); },
    removeSupplier(id){
      const s=this.supplier(id);if(!s)return;
      if(!this.confirm(`Limpar todos os preços e a resposta de ${s.name||'este fornecedor'}?`))return;
      const index=this.state.suppliers.findIndex(x=>x.id===id);
      const replacement=this.newSupplier(index+1);
      replacement.name=s.name||`FORNECEDOR ${index+1}`;
      this.state.suppliers.splice(index,1,replacement);
      delete this.imagePreviews[id];
      this.renderAll();
      this.toast(`${replacement.name} foi limpo.`);
    },
    updateSupplier(id,field,value){
      const s=this.supplier(id);if(!s)return;
      s[field]=['freight','documentTotal','documentExtra'].includes(field)?this.num(value):value;
      if(field==='responseText'&&s.confirmed){s.confirmed=false;s.offers=[];}
      if(field==='freight') this.renderResults();
      this.save();
    },
    setSupplierBusy(id,on,text='Processando...'){
      if(on)this.busySuppliers.add(id);else this.busySuppliers.delete(id);
      const el=this.$(`supplierBusy_${id}`);if(el)el.classList.toggle('show',!!on);
      const t=this.$(`supplierBusyText_${id}`);if(t)t.textContent=text;
    },

    knownBrands(){return ['LUK','VALEO','FANIA','MONROE','COFAP','AXIOS','NAKATA','SABO','SABÓ','SPICER','CORTECO','MOBENSANI','PERFECT','BROKITS','BROKIT','EFFARI','SKF','INA','TRW','VIEMAR'];},
    extractBrand(line){
      const p=this.plain(line);
      return this.knownBrands().find(b=>p.includes(this.plain(b)))||'';
    },
    parseAvailability(line){
      const p=this.plain(line);
      if(/NAO VAI|NAO TEM|SEM ESTOQUE|INDISPONIVEL|ESGOTADO/.test(p))return 'unavailable';
      if(/SO TEM|SOMENTE \d+|PARCIAL/.test(p))return 'partial';
      return 'available';
    },
    splitLines(text){ return String(text||'').split(/\r?\n|;/).map(x=>this.clean(x)).filter(Boolean); },
    parseOffersLocal(text){
      const rows=[];
      this.splitLines(text).forEach((raw,index)=>{
        let line=raw.replace(/^[\-–—•*]+\s*/,'').trim();
        if(!line)return;
        if(this.looksLikeVehicle(line) && !/R\$|CADA|REAIS?|PRE[CÇ]O|\d+[.,]\d{2}/i.test(line))return;
        const availability=this.parseAvailability(line);
        const partial=line.match(/s[oó]\s+tem\s+(\d+(?:[.,]\d+)?)/i);
        const qtyFound=this.wordsToNumber(line);
        let qty=qtyFound||0;
        if(partial)qty=this.num(partial[1]);
        const sanitized=line.replace(/s[oó]\s+tem\s+\d+(?:[.,]\d+)?/ig,' ');
        const nums=[...sanitized.matchAll(/(?:R\$\s*)?(\d+(?:[.,]\d{1,2})?)/g)];
        let priceMatch=null;
        for(let i=nums.length-1;i>=0;i--){
          const value=this.num(nums[i][1]);
          const full=nums[i][0];
          const before=sanitized.slice(0,nums[i].index||0);
          if(value>0 && !(/\b(?:19|20)$/.test(before.trim()) && value>=1900 && value<=2099)){priceMatch=nums[i];break;}
          if(full.includes(',')||full.includes('.')){priceMatch=nums[i];break;}
        }
        const rawPrice=availability==='unavailable'?0:(priceMatch?this.num(priceMatch[1]):0);
        if(!rawPrice && availability==='available') return;
        const each=/\b(cada|unit[aá]rio|por\s+unidade|por\s+pe[cç]a)\b/i.test(line);
        const totalWord=/\b(total|conjunto|par\s+por)\b/i.test(line);
        let priceType='unit';
        if(availability==='unavailable') priceType='unavailable';
        else if(qty>1 && !each && !totalWord) priceType='unknown';
        else if(totalWord && qty>1) priceType='total';
        const brand=this.extractBrand(line);
        let description=line;
        if(priceMatch) description=description.slice(0,priceMatch.index)+description.slice((priceMatch.index||0)+priceMatch[0].length);
        description=description
          .replace(/^(?:\d+(?:[.,]\d+)?|UM|UMA|DOIS|DUAS|PAR|TRES|TRÊS|QUATRO|CINCO|SEIS|SETE|OITO|NOVE|DEZ)\s+/i,'')
          .replace(/\b(cada|unit[aá]rio|por\s+unidade|por\s+pe[cç]a|reais?|s[oó]\s+tem\s+\d+|n[aã]o\s+vai|n[aã]o\s+tem)\b/ig,' ');
        if(brand)description=description.replace(new RegExp('\\b'+brand.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','ig'),' ');
        description=description.replace(/\s+/g,' ').trim()||'ITEM NÃO IDENTIFICADO';
        rows.push(this.normalizeDraft({order:index,description,brand,code:'',qty,qtyShown:!!qtyFound||!!partial,priceType,value:rawPrice,extra:0,availability,rawLine:raw,note:partial?`Fornecedor informou somente ${qty} unidade(s).`:''}));
      });
      return {rows,documentTotal:0,documentExtra:0};
    },

    getGroqKey(){
      try{
        const app=this.app();
        if(app && typeof app.getGroqKey==='function') return app.getGroqKey()||'';
        if(window.OS_API && typeof window.OS_API.getGroqKey==='function') return window.OS_API.getGroqKey()||'';
        return window.SOS_CONFIG?.GROQ_API_KEY||'';
      }catch(e){return '';}
    },
    getTextModel(){return window.SOS_CONFIG?.GROQ_CHAT_MODEL||'openai/gpt-oss-20b';},
    getVisionModel(){return window.SOS_CONFIG?.GROQ_VISION_MODEL||'qwen/qwen3.6-27b';},
    extractionSchema(){
      return {documentTotal:0,documentExtra:0,rows:[{description:'',brand:'',code:'',qty:0,qtyShown:false,priceType:'unit',value:0,extra:0,availability:'available',note:''}]};
    },
    extractionPrompt(kind,text=''){
      return `Leia somente os dados visíveis desta cotação automotiva. Responda em JSON válido no formato ${JSON.stringify(this.extractionSchema())}.
Regras: não invente; uma linha por produto; preserve marca/código; qty é somente a quantidade que estiver escrita e deve ser 0 quando não aparecer; a ausência de quantidade não significa falta de estoque; qtyShown informa se a quantidade estava visível; priceType é unit, total, unknown ou unavailable; value é o preço conforme priceType; extra é frete/ST da linha; documentTotal é o total final exibido. Se não estiver legível, deixe zero/vazio e explique em note.${kind==='TEXT'?`\nTEXTO:\n${text}`:''}`;
    },
    async groqText(prompt,key){
      const payload={
        model:this.getTextModel(),temperature:0,max_completion_tokens:1600,
        response_format:{type:'json_object'},
        messages:[{role:'system',content:'Extraia dados de cotação sem completar nem adivinhar informações ausentes.'},{role:'user',content:prompt}]
      };
      const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data=await res.json();
      if(!res.ok)throw new Error(data.error?.message||`Erro Groq ${res.status}`);
      return data.choices?.[0]?.message?.content||'';
    },
    async groqVision(prompt,dataUrl,key,maxTokens=1800){
      const payload={
        model:this.getVisionModel(),temperature:0,max_completion_tokens:maxTokens,
        response_format:{type:'json_object'},reasoning_effort:'none',
        messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:dataUrl}}]}]
      };
      const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data=await res.json();
      if(!res.ok){
        const err=new Error(data.error?.message||`Erro Groq Vision ${res.status}`);
        err.status=res.status;throw err;
      }
      return data.choices?.[0]?.message?.content||'';
    },
    extractJSON(content){
      let text=String(content||'').replace(/```json|```/gi,'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
      const first=text.indexOf('{'),last=text.lastIndexOf('}');
      if(first>=0&&last>first)text=text.slice(first,last+1);
      try{return JSON.parse(text);}catch(e){
        text=text.replace(/,\s*([}\]])/g,'$1');
        try{return JSON.parse(text);}catch(e2){throw new Error('A leitura não retornou dados válidos.');}
      }
    },
    imageToDataURL(file,maxSide=1200,quality=.72){
      return new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onerror=()=>reject(new Error('Falha ao abrir a imagem.'));
        reader.onload=()=>{
          const img=new Image();
          img.onerror=()=>reject(new Error('Imagem inválida.'));
          img.onload=()=>{
            const scale=Math.min(1,maxSide/Math.max(img.width,img.height));
            const canvas=document.createElement('canvas');
            canvas.width=Math.max(1,Math.round(img.width*scale));
            canvas.height=Math.max(1,Math.round(img.height*scale));
            const ctx=canvas.getContext('2d',{alpha:false});
            ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(img,0,0,canvas.width,canvas.height);
            resolve(canvas.toDataURL('image/jpeg',quality));
          };
          img.src=reader.result;
        };
        reader.readAsDataURL(file);
      });
    },
    normalizeDraft(raw){
      const priceType=['unit','total','unknown','unavailable'].includes(raw?.priceType)?raw.priceType:(raw?.availability==='unavailable'?'unavailable':'unknown');
      const availability=['available','partial','unavailable','unknown'].includes(raw?.availability)?raw.availability:(priceType==='unavailable'?'unavailable':'available');
      return {
        id:raw?.id||this.id('off'),order:this.num(raw?.order),description:String(raw?.description||'').trim(),brand:String(raw?.brand||'').trim(),code:String(raw?.code||'').trim(),
        qty:this.num(raw?.qty),qtyShown:!!raw?.qtyShown,priceType,value:this.num(raw?.value),extra:this.num(raw?.extra),availability,
        note:String(raw?.note||'').trim(),rawLine:String(raw?.rawLine||'').trim(),requestedId:String(raw?.requestedId||''),ignored:!!raw?.ignored,source:raw?.source||''
      };
    },
    normalizeParsed(parsed,source){
      const rows=Array.isArray(parsed?.rows)?parsed.rows:[];
      return {
        rows:rows.map((r,i)=>this.normalizeDraft({...r,order:i,source})).filter(r=>r.description||r.value||r.availability==='unavailable'),
        documentTotal:this.num(parsed?.documentTotal),documentExtra:this.num(parsed?.documentExtra)
      };
    },
    async processSupplierText(id){
      const s=this.supplier(id);if(!s)return;
      const text=String(this.$(`supplierText_${id}`)?.value??s.responseText??'').trim();
      if(!text){this.toast('Cole a resposta do fornecedor.');return;}
      if(!this.state.requested.length){this.toast('Primeiro carregue a lista solicitada.');return;}
      s.responseText=text;s.confirmed=false;s.offers=[];
      this.setSupplierBusy(id,true,'Interpretando a mensagem...');
      try{
        const parsed=this.parseOffersLocal(text);
        this.applyDraft(s,parsed,'text');
      }catch(e){
        console.error(e);
        s.draftOffers=[];s.confirmed=false;s.offers=[];
        this.renderAll();
        this.toast('Não foi possível interpretar a mensagem. Nenhum preço foi salvo.');
      }finally{this.setSupplierBusy(id,false);}
    },
    async processSupplierImage(id,input){
      const s=this.supplier(id),file=input?.files?.[0];if(!s||!file)return;
      if(!this.state.requested.length){this.toast('Primeiro carregue a lista solicitada.');input.value='';return;}
      const key=this.getGroqKey();
      if(!key){this.toast('A chave Groq não está configurada. Nenhum dado foi incluído.');input.value='';return;}
      s.imageName=file.name;s.confirmed=false;s.offers=[];
      if(this.imagePreviews[id]){try{URL.revokeObjectURL(this.imagePreviews[id]);}catch(e){}}
      this.imagePreviews[id]=URL.createObjectURL(file);
      const preview=this.$(`supplierPreview_${id}`);
      if(preview){preview.src=this.imagePreviews[id];preview.classList.add('show');}
      this.setSupplierBusy(id,true,'Lendo a foto...');
      try{
        let dataUrl=await this.imageToDataURL(file,1200,.72);
        let content;
        try{
          content=await this.groqVision(this.extractionPrompt('IMAGE'),dataUrl,key,1800);
        }catch(firstError){
          const msg=String(firstError.message||'');
          if(firstError.status===429 || /too large|token limit|tokens per minute|requested/i.test(msg)){
            this.setSupplierBusy(id,true,'Reduzindo a foto e tentando novamente...');
            dataUrl=await this.imageToDataURL(file,900,.62);
            content=await this.groqVision(this.extractionPrompt('IMAGE'),dataUrl,key,1000);
          }else throw firstError;
        }
        const parsed=this.normalizeParsed(this.extractJSON(content),'image');
        this.applyDraft(s,parsed,'image');
      }catch(e){
        console.error(e);
        s.draftOffers=[];s.confirmed=false;s.offers=[];
        this.renderAll();
        this.toast('A foto não foi lida. Nenhum preço foi salvo. Use outra foto ou cole o texto.');
      }finally{
        this.setSupplierBusy(id,false);input.value='';
      }
    },
    applyDraft(s,parsed,source){
      s.documentTotal=this.num(parsed?.documentTotal);
      s.documentExtra=this.num(parsed?.documentExtra);
      const rows=parsed?.rows||[];
      s.draftOffers=rows.map((o,i)=>{
        const row=this.normalizeDraft({...o,source,order:i});
        row.requestedId=this.suggestRequestedId(row,i,rows.length);
        const req=this.state.requested.find(r=>r.id===row.requestedId);
        if(row.priceType==='unknown' && (!row.qtyShown || (req&&this.num(req.qty)<=1))) row.priceType='unit';
        return row;
      });
      s.confirmed=false;s.offers=[];
      this.renderAll();
      if(s.draftOffers.length) this.toast(`${s.draftOffers.length} preço(s) encontrado(s). Confira somente o que o fornecedor respondeu.`);
      else this.toast('Nenhum preço legível foi encontrado. Nenhum dado foi salvo.');
    },

    normalizeMatch(value){
      let p=this.plain(value);
      const rep=[
        [/\bPNEUZINHOS?\b/g,' BUCHA BARRA ESTABILIZADORA '],
        [/\bCOIFA RODA\b/g,' COIFA HOMOCINETICA EXTERNA '],
        [/\bCOIFA CAMBIO\b/g,' COIFA HOMOCINETICA INTERNA '],
        [/\bRETENTOR MANCAL\b/g,' RETENTOR VIRABREQUIM TRASEIRO '],
        [/\bBRACOS? OSCILANTES?\b/g,' BRACO OSCILANTE '],
        [/\bAMORTECEDORES\b/g,' AMORTECEDOR '],
        [/\bDIANTEIROS?\b/g,' DIANTEIRO '],
        [/\bTRASEIROS?\b/g,' TRASEIRO '],
        [/\bEXTERNAS?\b/g,' EXTERNA '],
        [/\bINTERNAS?\b/g,' INTERNA '],
        [/\bBUCHAS\b/g,' BUCHA '],
        [/\bKITS\b/g,' KIT '],
        [/\bPIVOS?\b/g,' PIVO '],
        [/\bBANDEJAS\b/g,' BANDEJA '],
        [/\bEMBREAGENS\b/g,' EMBREAGEM ']
      ];
      rep.forEach(([r,v])=>p=p.replace(r,v));
      return p.replace(/\s+/g,' ').trim();
    },
    concept(value){
      const p=this.normalizeMatch(value);
      if(/CABO.*EMBREAGEM|EMBREAGEM.*CABO/.test(p))return 'CABO_EMBREAGEM';
      if(/EMBREAGEM/.test(p))return 'EMBREAGEM';
      if(/RETENTOR/.test(p)&&/(MANCAL|VIRABREQUIM|FLANGE)/.test(p))return 'RETENTOR';
      if(/COIFA/.test(p)&&/(EXTERNA|RODA)/.test(p))return 'COIFA_EXTERNA';
      if(/COIFA/.test(p)&&/(INTERNA|CAMBIO)/.test(p))return 'COIFA_INTERNA';
      if(/AMORTECEDOR/.test(p)&&/(KIT|BATENTE|COXIM)/.test(p))return 'KIT_AMORTECEDOR';
      if(/AMORTECEDOR/.test(p))return 'AMORTECEDOR';
      if(/BRACO OSCILANTE/.test(p))return 'BRACO';
      if(/BUCHA.*BANDEJA|BANDEJA.*BUCHA/.test(p))return 'BUCHA_BANDEJA';
      if(/PIVO/.test(p))return 'PIVO';
      if(/TERMINAL.*BARRA|LIGACAO.*BARRA/.test(p))return 'LIGACAO_BARRA';
      if(/BUCHA.*BARRA|BARRA.*BUCHA/.test(p))return 'BUCHA_BARRA';
      if(/\bKIT\b/.test(p))return 'KIT';
      return '';
    },
    matchScore(request,offer){
      const a=this.normalizeMatch(request.description),b=this.normalizeMatch(offer.description);
      if(!a||!b)return 0;
      const frontA=/DIANTEIRO/.test(a),rearA=/TRASEIRO/.test(a),frontB=/DIANTEIRO/.test(b),rearB=/TRASEIRO/.test(b);
      const inA=/INTERNA/.test(a),outA=/EXTERNA/.test(a),inB=/INTERNA/.test(b),outB=/EXTERNA/.test(b);
      if((frontA&&rearB)||(rearA&&frontB)||(inA&&outB)||(outA&&inB))return 0;
      const ca=this.concept(a),cb=this.concept(b);
      const A=new Set(a.split(' ').filter(w=>w.length>2)),B=new Set(b.split(' ').filter(w=>w.length>2));
      const inter=[...A].filter(x=>B.has(x)).length,union=new Set([...A,...B]).size||1;
      let score=inter/union;
      if(a===b)score+=1;
      if(a.includes(b)||b.includes(a))score+=.4;
      if(ca&&cb&&ca===cb)score+=1;
      if(ca==='KIT'&&cb==='KIT_AMORTECEDOR')score+=.35;
      return score;
    },
    suggestRequestedId(offer,offerIndex,totalOffers){
      if(!this.state.requested.length)return '';
      const ranked=this.state.requested.map((r,i)=>{
        let score=this.matchScore(r,offer);
        if(this.concept(r.description)==='KIT' && this.concept(offer.description).startsWith('KIT')){
          const pa=this.state.requested.length>1?i/(this.state.requested.length-1):0;
          const pb=totalOffers>1?offerIndex/(totalOffers-1):0;
          score+=Math.max(0,.12-Math.abs(pa-pb)*.12);
        }
        return {id:r.id,index:i,score,normalized:this.normalizeMatch(r.description),concept:this.concept(r.description)};
      }).sort((a,b)=>b.score-a.score);
      const best=ranked[0],second=ranked[1];
      if(!best||best.score<.55)return '';
      const sameDescription=this.state.requested.filter(r=>this.normalizeMatch(r.description)===best.normalized).length>1;
      const generic=['KIT','RETENTOR'].includes(best.concept);
      const tied=second&&Math.abs(best.score-second.score)<.08;
      if(sameDescription||tied&&generic)return '';
      return best.id;
    },

    updateDraft(id,offerId,field,value){
      const s=this.supplier(id),o=s?.draftOffers?.find(x=>x.id===offerId);if(!o)return;
      if(['qty','value','extra'].includes(field)){o[field]=this.num(value);if(field==='qty')o.qtyShown=true;}
      else if(field==='ignored')o[field]=!!value;
      else o[field]=value;
      s.confirmed=false;s.offers=[];
      this.renderDraftStatus(id);this.save();
    },
    removeDraft(id,offerId){
      const s=this.supplier(id);if(!s)return;
      s.draftOffers=s.draftOffers.filter(x=>x.id!==offerId);s.confirmed=false;s.offers=[];this.renderAll();
    },
    addDraft(id){
      const s=this.supplier(id);if(!s)return;
      s.confirmed=false;s.offers=[];
      s.draftOffers.push(this.normalizeDraft({description:'',qty:1,qtyShown:true,priceType:'unknown',value:0,availability:'available'}));
      this.renderAll();
    },
    fillRequestedQuantities(id){
      const s=this.supplier(id);if(!s)return;
      if(!this.confirm('Preencher somente as linhas em que o fornecedor não informou quantidade, usando a quantidade da lista solicitada?'))return;
      let count=0;
      (s.draftOffers||[]).forEach(o=>{
        if(o.ignored||o.qtyShown||!o.requestedId)return;
        const r=this.state.requested.find(x=>x.id===o.requestedId);if(!r)return;
        o.qty=this.num(r.qty);o.qtyShown=true;count++;
      });
      this.renderAll();this.toast(`${count} quantidade(s) preenchida(s) a partir da lista.`);
    },
    editSupplier(id){
      const s=this.supplier(id);if(!s)return;
      if(!s.draftOffers.length)s.draftOffers=(s.offers||[]).map(o=>this.normalizeDraft({...o,id:this.id('off')}));
      s.confirmed=false;s.offers=[];this.renderAll();
    },
    effectiveLine(o,request=null){
      if(o.availability==='unavailable'||o.priceType==='unavailable')return 0;
      const requestedQty=Math.max(.0001,this.num(request?.qty)||1);
      const lineQty=Math.max(.0001,this.num(o.qty)||requestedQty);
      const base=o.priceType==='unit'?this.num(o.value)*requestedQty:this.num(o.value);
      const extra=this.num(o.extra);
      return base+extra;
    },
    rowCheck(o){
      const issues=[];
      const request=this.state.requested.find(r=>r.id===o.requestedId)||null;
      if(o.ignored) return {usable:false,issues:['Linha ignorada.'],request};
      if(!request) issues.push('Escolha qual peça da sua lista corresponde a este preço.');
      if(o.availability==='unavailable'||o.priceType==='unavailable'){
        return {usable:!!request,issues,request,unavailable:true};
      }
      if(this.num(o.value)<=0) issues.push('Informe um preço válido.');
      if(o.priceType==='unknown') issues.push('Escolha se o preço é unitário ou total.');
      if(o.availability==='partial'&&this.num(o.qty)<=0) issues.push('Informe quantas unidades o fornecedor possui.');
      return {usable:issues.length===0,issues,request,unavailable:false};
    },
    draftValidation(s){
      const rows=(s.draftOffers||[]).filter(o=>!o.ignored);
      const valid=[];
      const pending=[];
      rows.forEach((o,index)=>{
        const check=this.rowCheck(o);
        if(check.usable) valid.push(o);
        else pending.push({row:o,index,issues:check.issues});
      });
      const calculated=valid.reduce((sum,o)=>{
        const request=this.state.requested.find(r=>r.id===o.requestedId);
        return sum+this.effectiveLine(o,request);
      },0);
      const doc=this.num(s.documentTotal);
      const tolerance=Math.max(.10,doc*.002);
      const mismatch=doc>0&&Math.abs(calculated-doc)>tolerance;
      return {rows,valid,pending,calculated,mismatch,documentTotal:doc};
    },
    confirmSupplier(id){
      const s=this.supplier(id);if(!s)return;
      const validation=this.draftValidation(s);
      if(!validation.valid.length){
        this.toast('Ainda não existe nenhum preço pronto para salvar.');
        this.renderDraftStatus(id,true);
        return;
      }
      s.offers=validation.valid.map(o=>this.normalizeDraft({...o,id:o.id}));
      s.confirmed=true;s.confirmedAt=new Date().toISOString();
      this.renderAll();
      const ignored=validation.pending.length;
      this.toast(`${s.name}: ${s.offers.length} preço(s) salvo(s)${ignored?` e ${ignored} linha(s) não usada(s)`:''}.`);
    },
    renderDraftStatus(id,showPending=false){
      const s=this.supplier(id);if(!s)return;
      const validation=this.draftValidation(s);
      const btn=this.$(`confirmSupplier_${id}`);
      if(btn){
        btn.disabled=validation.valid.length===0;
        btn.innerHTML=`<i class="fa-solid fa-check"></i> SALVAR ${validation.valid.length} PREÇO(S) CONFERIDO(S)`;
      }
      const info=this.$(`supplierCheck_${id}`);
      if(info){
        const pieces=[];
        if(validation.valid.length) pieces.push(`<b>${validation.valid.length} preço(s) pronto(s).</b>`);
        if(validation.pending.length) pieces.push(`${validation.pending.length} linha(s) ainda precisam de ajuste e não serão salvas.`);
        if(validation.mismatch) pieces.push(`O total informado (${this.money(validation.documentTotal)}) difere da soma utilizável (${this.money(validation.calculated)}). Isso é apenas um aviso.`);
        if(!pieces.length) pieces.push('Nenhum preço foi identificado.');
        info.className='compare-check '+(validation.valid.length?'ok':'bad');
        info.innerHTML=pieces.join(' ');
      }
      const err=this.$(`supplierErrors_${id}`);
      if(err){
        if((showPending||validation.valid.length===0)&&validation.pending.length){
          err.innerHTML=validation.pending.map(p=>`<div><b>Linha ${p.index+1}:</b> ${this.esc(p.issues[0])}</div>`).join('');
          err.classList.add('show');
        }else{err.innerHTML='';err.classList.remove('show');}
      }
    },
    requestedOptions(selected){
      return `<option value="">ESCOLHA A PEÇA</option><option value="__ignore" ${selected==='__ignore'?'selected':''}>NÃO USAR ESTA LINHA</option>`+
        this.state.requested.map((r,i)=>`<option value="${r.id}" ${selected===r.id?'selected':''}>${i+1}. ${this.esc(r.description)} — QTD ${this.esc(r.qty)}</option>`).join('');
    },
    renderDraftRows(s){
      if(!s.draftOffers.length)return '';
      return `<div class="compare-review-title"><i class="fa-solid fa-circle-check"></i><div><b>Confira somente os preços respondidos</b><span>O fornecedor não precisa cotar toda a lista. Uma única peça já pode ser salva.</span></div></div>
      <div id="supplierErrors_${s.id}" class="compare-errors"></div>
      <div class="compare-review-list">${s.draftOffers.map((o,i)=>{
        const request=this.state.requested.find(r=>r.id===o.requestedId);
        const check=this.rowCheck(o);
        const status=check.usable?'ready':(o.ignored?'ignored':'pending');
        const typeLabel=o.priceType==='unit'?'POR UNIDADE':o.priceType==='total'?'TOTAL DA LINHA':o.priceType==='unavailable'?'NÃO TEM':'ESCOLHER';
        return `<div class="compare-review-row ${status}">
          <div class="compare-review-head"><div><b>${this.esc(o.description||`Linha ${i+1}`)}</b><span class="compare-row-status ${status}">${check.usable?'PRONTO':o.ignored?'NÃO USAR':'REVISAR'}</span></div><button class="btn bad small compare-icon-btn" onclick="Comparator.removeDraft('${s.id}','${o.id}')" title="Excluir linha"><i class="fa-solid fa-trash"></i></button></div>
          <div class="compare-essential-grid">
            <div class="wide"><label>Qual peça da sua lista?</label><select onchange="Comparator.updateDraft('${s.id}','${o.id}','requestedId',this.value==='__ignore'?'':this.value);Comparator.updateDraft('${s.id}','${o.id}','ignored',this.value==='__ignore')">${this.requestedOptions(o.ignored?'__ignore':o.requestedId)}</select></div>
            <div><label>Marca</label><input value="${this.attr(o.brand)}" placeholder="Ex.: LUK" oninput="Comparator.updateDraft('${s.id}','${o.id}','brand',this.value)"></div>
            <div><label>Preço informado</label><input inputmode="decimal" value="${this.attr(o.value||'')}" placeholder="0,00" oninput="Comparator.updateDraft('${s.id}','${o.id}','value',this.value)"></div>
            <div><label>Esse preço é</label><select onchange="Comparator.updateDraft('${s.id}','${o.id}','priceType',this.value)">
              <option value="unknown" ${o.priceType==='unknown'?'selected':''}>ESCOLHER</option>
              <option value="unit" ${o.priceType==='unit'?'selected':''}>POR UNIDADE</option>
              <option value="total" ${o.priceType==='total'?'selected':''}>TOTAL DA LINHA</option>
              <option value="unavailable" ${o.priceType==='unavailable'?'selected':''}>NÃO TEM</option>
            </select></div>
          </div>
          <div class="compare-calc-note">${request?`Será comparado para <b>${this.esc(request.qty)} unidade(s)</b> pedida(s).`: 'Escolha a peça correspondente para liberar este preço.'} ${o.availability==='partial'?`Fornecedor informou disponibilidade parcial de <b>${this.esc(o.qty)}</b>.`:''}</div>
          <details class="compare-row-more"><summary>Mais detalhes</summary><div class="compare-advanced-grid">
            <div><label>Descrição original</label><input value="${this.attr(o.description)}" oninput="Comparator.updateDraft('${s.id}','${o.id}','description',this.value)"></div>
            <div><label>Disponibilidade</label><select onchange="Comparator.updateDraft('${s.id}','${o.id}','availability',this.value)"><option value="available" ${o.availability==='available'?'selected':''}>TEM / COTOU</option><option value="partial" ${o.availability==='partial'?'selected':''}>SÓ TEM PARTE</option><option value="unavailable" ${o.availability==='unavailable'?'selected':''}>NÃO TEM</option></select></div>
            <div><label>Qtd. informada</label><input inputmode="decimal" value="${this.attr(o.qty||'')}" placeholder="Opcional" oninput="Comparator.updateDraft('${s.id}','${o.id}','qty',this.value)"></div>
            <div><label>Frete/ST desta linha</label><input inputmode="decimal" value="${this.attr(o.extra||'')}" placeholder="0,00" oninput="Comparator.updateDraft('${s.id}','${o.id}','extra',this.value)"></div>
            <div><label>Código</label><input value="${this.attr(o.code)}" placeholder="Opcional" oninput="Comparator.updateDraft('${s.id}','${o.id}','code',this.value)"></div>
            <div><label>Observação</label><input value="${this.attr(o.note)}" placeholder="Opcional" oninput="Comparator.updateDraft('${s.id}','${o.id}','note',this.value)"></div>
          </div>${o.rawLine?`<div class="compare-source-line"><b>Resposta original:</b> ${this.esc(o.rawLine)}</div>`:''}</details>
        </div>`;
      }).join('')}</div>
      <div class="compare-simple-actions compare-draft-actions"><button class="btn line" onclick="Comparator.addDraft('${s.id}')"><i class="fa-solid fa-plus"></i> Adicionar preço manual</button></div>
      <details class="compare-total-more"><summary>Frete e conferência do total</summary><div class="compare-total-grid"><div><label>Total mostrado na foto (opcional)</label><input inputmode="decimal" value="${this.attr(s.documentTotal||'')}" placeholder="0,00" oninput="Comparator.updateSupplier('${s.id}','documentTotal',this.value);Comparator.renderDraftStatus('${s.id}')"></div><div><label>Frete fixo do fornecedor (opcional)</label><input inputmode="decimal" value="${this.attr(s.freight||'')}" placeholder="0,00" oninput="Comparator.updateSupplier('${s.id}','freight',this.value)"></div></div></details>
      <div id="supplierCheck_${s.id}" class="compare-check"></div>
      <button id="confirmSupplier_${s.id}" class="btn ok block compare-confirm" onclick="Comparator.confirmSupplier('${s.id}')"><i class="fa-solid fa-check"></i> SALVAR PREÇOS CONFERIDOS</button>`;
    },
    renderSuppliers(){
      const box=this.$('compareSuppliers');if(!box)return;
      this.ensureThreeSuppliers();
      box.innerHTML=this.state.suppliers.map((s,index)=>{
        const confirmed=s.confirmed;
        const confirmedRows=(s.offers||[]).map(o=>{
          const req=this.state.requested.find(r=>r.id===o.requestedId);
          const label=o.priceType==='unit'?`${this.money(o.value)} cada`:o.priceType==='total'?`${this.money(o.value)} total`:'NÃO TEM';
          return `<div class="compare-confirmed-line"><div><b>${this.esc(req?.description||o.description)}</b><span>${this.esc(o.brand||'SEM MARCA INFORMADA')}</span></div><strong>${label}</strong></div>`;
        }).join('');
        return `<div class="compare-supplier-card ${confirmed?'confirmed':''}">
          <div class="compare-supplier-head">
            <div class="compare-supplier-name"><span>${index+1}</span><div class="compare-supplier-title"><small>FORNECEDOR ${index+1}</small><input aria-label="Nome do fornecedor ${index+1}" value="${this.attr(s.name)}" oninput="Comparator.updateSupplier('${s.id}','name',this.value);Comparator.renderResults()"></div></div>
            <div class="compare-supplier-status ${confirmed?'ok':'wait'}"><i class="fa-solid ${confirmed?'fa-circle-check':'fa-clock'}"></i>${confirmed?`${s.offers.length} PREÇO(S) SALVO(S)`:'AGUARDANDO RESPOSTA'}</div>
          </div>
          ${confirmed?`<div class="compare-success"><b>Preços conferidos.</b> As peças que este fornecedor não respondeu aparecem como “não respondeu” na tabela.</div><div class="compare-confirmed-list">${confirmedRows||'<div class="compare-empty">Nenhum preço salvo.</div>'}</div>
          <div class="compare-simple-actions"><button class="btn main" onclick="Comparator.editSupplier('${s.id}')"><i class="fa-solid fa-pen"></i> Adicionar ou editar preços</button><button class="btn line" onclick="Comparator.removeSupplier('${s.id}')"><i class="fa-solid fa-broom"></i> Limpar fornecedor</button></div>`:
          `<div class="compare-source-controls">
            <label>Resposta recebida</label>
            <textarea id="supplierText_${s.id}" class="compare-source" placeholder="Cole somente o que este fornecedor respondeu. Pode ser apenas uma peça." oninput="Comparator.updateSupplier('${s.id}','responseText',this.value)">${this.esc(s.responseText||'')}</textarea>
            <div class="compare-simple-actions compare-read-actions">
              <button class="btn main" onclick="Comparator.processSupplierText('${s.id}')"><i class="fa-solid fa-wand-magic-sparkles"></i> Interpretar mensagem</button>
              <label class="btn line" for="supplierImage_${s.id}"><i class="fa-solid fa-camera"></i> Ler foto</label>
              <input id="supplierImage_${s.id}" class="compare-file" type="file" accept="image/*" onchange="Comparator.processSupplierImage('${s.id}',this)">
              <button class="btn line" onclick="Comparator.removeSupplier('${s.id}')"><i class="fa-solid fa-broom"></i> Limpar</button>
            </div>
            <img id="supplierPreview_${s.id}" src="${this.attr(this.imagePreviews[s.id]||'')}" class="compare-image-preview ${this.imagePreviews[s.id]?'show':''}" alt="Prévia da cotação">
            <div id="supplierBusy_${s.id}" class="compare-progress"><span class="compare-spinner"></span><span id="supplierBusyText_${s.id}">Processando...</span></div>
          </div>
          ${this.renderDraftRows(s)}`}
        </div>`;
      }).join('');
      this.state.suppliers.forEach(s=>{if(!s.confirmed&&s.draftOffers.length)this.renderDraftStatus(s.id);});
    },

    offerForRequest(s,request){
      return (s.offers||[]).filter(o=>o.requestedId===request.id).map(o=>this.offerResult(s,request,o));
    },
    offerResult(s,r,o){
      const reqQty=this.num(r.qty)||1;
      const quotedQty=this.num(o.qty)||reqQty;
      const unavailable=o.availability==='unavailable'||o.priceType==='unavailable';
      const partial=!unavailable&&o.availability==='partial';
      const denominator=Math.max(.0001,quotedQty);
      const baseUnit=o.priceType==='unit'?this.num(o.value):(this.num(o.value)/denominator);
      const extraUnit=this.num(o.extra)/Math.max(.0001,reqQty);
      const unitCost=baseUnit+extraUnit;
      return {supplierId:s.id,supplierName:s.name,freight:this.num(s.freight),requestId:r.id,description:r.description,brand:o.brand,code:o.code,requiredQty:reqQty,offeredQty:partial?quotedQty:reqQty,unitCost,total:unitCost*reqQty,enough:!unavailable&&!partial,unavailable,partial,note:o.note,source:o};
    },
    computeResult(){
      const confirmed=this.state.suppliers.filter(s=>s.confirmed);
      const items=this.state.requested.map(r=>{
        const offers=confirmed.flatMap(s=>this.offerForRequest(s,r));
        const complete=offers.filter(o=>o.enough&&o.unitCost>0).sort((a,b)=>a.total-b.total);
        const partial=offers.filter(o=>!o.enough&&!o.unavailable&&o.unitCost>0).sort((a,b)=>a.total-b.total);
        const unavailable=offers.filter(o=>o.unavailable);
        return {request:r,offers,complete,partial,unavailable,winner:complete[0]||null};
      });
      const winners=items.map(x=>x.winner).filter(Boolean);
      const usedIds=[...new Set(winners.map(w=>w.supplierId))];
      const mixedItems=winners.reduce((a,w)=>a+w.total,0);
      const mixedFreight=usedIds.reduce((a,id)=>a+this.num(confirmed.find(s=>s.id===id)?.freight),0);
      const mixedTotal=mixedItems+mixedFreight;
      const singlePlans=confirmed.map(s=>{
        const lines=[];let complete=true;
        items.forEach(item=>{
          const candidates=this.offerForRequest(s,item.request).filter(o=>o.enough&&o.unitCost>0).sort((a,b)=>a.total-b.total);
          if(!candidates.length)complete=false;else lines.push(candidates[0]);
        });
        const itemTotal=lines.reduce((a,x)=>a+x.total,0);
        return {supplier:s,lines,complete,total:itemTotal+this.num(s.freight)};
      }).filter(p=>p.complete).sort((a,b)=>a.total-b.total);
      return {confirmed,items,winners,usedIds,mixedItems,mixedFreight,mixedTotal,singleBest:singlePlans[0]||null,missing:items.filter(x=>!x.winner).length};
    },
    itemOffersForSupplier(item,supplier){
      return (item.offers||[]).filter(o=>o.supplierId===supplier.id).sort((a,b)=>{
        if(a.enough!==b.enough) return a.enough?-1:1;
        if(a.partial!==b.partial) return a.partial?-1:1;
        return (a.total||0)-(b.total||0);
      });
    },
    offerOptionHTML(offer,winner){
      const isWinner=!!winner && offer.supplierId===winner.supplierId && offer.source?.id===winner.source?.id;
      const classes=['compare-matrix-option'];
      if(isWinner) classes.push('best');
      if(offer.partial) classes.push('partial');
      if(offer.unavailable) classes.push('unavailable');
      if(offer.unavailable){
        return `<div class="${classes.join(' ')}"><div class="compare-option-top"><b>${this.esc(offer.brand||'SEM MARCA')}</b><span>NÃO TEM</span></div>${offer.note?`<small>${this.esc(offer.note)}</small>`:''}</div>`;
      }
      const stock=offer.partial?`SÓ TEM ${this.esc(offer.offeredQty)} DE ${this.esc(offer.requiredQty)}`:'';
      return `<div class="${classes.join(' ')}">
        <div class="compare-option-top"><b>${this.esc(offer.brand||'SEM MARCA INFORMADA')}</b>${isWinner?'<span class="compare-best-badge"><i class="fa-solid fa-trophy"></i> MAIS BARATO</span>':''}</div>
        ${offer.code?`<small>Cód. ${this.esc(offer.code)}</small>`:''}
        <div class="compare-option-prices"><span>${this.money(offer.unitCost)} <small>cada</small></span><strong>${this.money(offer.total)} <small>total</small></strong></div>
        ${stock?`<div class="compare-stock-warning">${stock}</div>`:''}
        ${offer.note?`<small class="compare-option-note">${this.esc(offer.note)}</small>`:''}
      </div>`;
    },
    supplierMatrixCellHTML(item,supplier){
      const offers=this.itemOffersForSupplier(item,supplier);
      if(!supplier.confirmed) return '<div class="compare-cell-empty"><i class="fa-regular fa-clock"></i><b>AGUARDANDO</b><span>Nenhum preço salvo</span></div>';
      if(!offers.length) return '<div class="compare-cell-empty"><i class="fa-solid fa-minus"></i><b>NÃO RESPONDEU</b><span>Esta peça não foi cotada</span></div>';
      return offers.map(o=>this.offerOptionHTML(o,item.winner)).join('');
    },
    supplierCoverage(supplier,result){
      let covered=0,total=0;
      result.items.forEach(item=>{
        const complete=this.itemOffersForSupplier(item,supplier).filter(o=>o.enough&&o.unitCost>0);
        if(complete.length){covered++;total+=complete[0].total;}
      });
      return {covered,total:total+this.num(supplier.freight)};
    },
    renderResults(){
      const box=this.$('compareResults');if(!box)return;
      if(!this.state.requested.length){box.innerHTML='<div class="compare-empty">Carregue a lista das peças. A tabela com os 3 fornecedores será criada automaticamente.</div>';return;}
      this.ensureThreeSuppliers();
      const result=this.computeResult();
      const supplierSummaries=this.state.suppliers.map(s=>({supplier:s,...this.supplierCoverage(s,result)}));
      const actions=`<div class="compare-result-actions">
        <button class="btn ok" onclick="Comparator.generateComparisonPDF()" ${!result.confirmed.length?'disabled':''}><i class="fa-solid fa-file-pdf"></i> Gerar PDF da comparação</button>
        <button class="btn line" onclick="Comparator.shareComparisonPDF()" ${!result.confirmed.length?'disabled':''}><i class="fa-solid fa-share-nodes"></i> Compartilhar PDF</button>
        <button class="btn main" onclick="Comparator.addWinnersToBudget()" ${!result.winners.length?'disabled':''}><i class="fa-solid fa-cart-plus"></i> Levar menores ao orçamento</button>
      </div>`;
      const summary=`<div class="compare-kpis compare-kpis-visual">
        <div class="compare-kpi"><span>Peças da lista</span><b>${this.state.requested.length}</b></div>
        <div class="compare-kpi"><span>Com algum preço</span><b>${result.winners.length}</b></div>
        <div class="compare-kpi ${result.missing?'warn':'good'}"><span>Sem preço completo</span><b>${result.missing}</b></div>
        <div class="compare-kpi good"><span>Compra pelos menores</span><b>${result.winners.length?this.money(result.mixedTotal):'—'}</b><small>Fretes fixos incluídos uma vez</small></div>
      </div>`;
      const supplierStrip=`<div class="compare-supplier-summary-strip">${supplierSummaries.map((x,index)=>`<div><span>${index+1}</span><section><b>${this.esc(x.supplier.name)}</b><small>${x.covered} de ${this.state.requested.length} peça(s) com preço completo${this.num(x.supplier.freight)>0?` · frete ${this.money(x.supplier.freight)}`:''}</small></section><strong>${x.covered?this.money(x.total):'—'}</strong></div>`).join('')}</div>`;
      const header=`<div class="compare-matrix-row compare-matrix-head">
        <div>PEÇA / QUANTIDADE</div>
        ${this.state.suppliers.map((s,i)=>`<div><span>FORNECEDOR ${i+1}</span><b>${this.esc(s.name)}</b></div>`).join('')}
        <div>MELHOR OPÇÃO</div>
      </div>`;
      const rows=result.items.map((item,index)=>`<div class="compare-matrix-row compare-matrix-body-row">
        <div class="compare-piece-cell"><span>${index+1}</span><section><b>${this.esc(item.request.description)}</b><small>Quantidade necessária: ${this.esc(item.request.qty)}</small></section></div>
        ${this.state.suppliers.map(s=>`<div class="compare-supplier-cell ${item.winner&&item.winner.supplierId===s.id?'has-best':''}">${this.supplierMatrixCellHTML(item,s)}</div>`).join('')}
        <div class="compare-best-cell">${item.winner?`<i class="fa-solid fa-trophy"></i><b>${this.esc(item.winner.supplierName)}</b><span>${this.esc(item.winner.brand||'SEM MARCA')}</span><strong>${this.money(item.winner.total)}</strong><small>${this.money(item.winner.unitCost)} cada</small>`:'<i class="fa-solid fa-triangle-exclamation"></i><b>SEM PREÇO</b><span>Aguardando cotação completa</span>'}</div>
      </div>`).join('');
      const desktop=`<div class="compare-matrix-wrap"><div class="compare-matrix">${header}${rows}</div></div>`;
      const mobile=`<div class="compare-mobile-list">${result.items.map((item,index)=>`<article class="compare-mobile-piece">
        <header><span>${index+1}</span><section><b>${this.esc(item.request.description)}</b><small>Quantidade: ${this.esc(item.request.qty)}</small></section></header>
        <div class="compare-mobile-suppliers">${this.state.suppliers.map((s,i)=>`<div class="compare-mobile-supplier ${item.winner&&item.winner.supplierId===s.id?'has-best':''}"><div class="compare-mobile-supplier-head"><span>FORNECEDOR ${i+1}</span><b>${this.esc(s.name)}</b></div>${this.supplierMatrixCellHTML(item,s)}</div>`).join('')}</div>
        <footer>${item.winner?`<span><i class="fa-solid fa-trophy"></i> MELHOR: <b>${this.esc(item.winner.supplierName)}</b></span><strong>${this.money(item.winner.total)}</strong>`:'<span><i class="fa-solid fa-triangle-exclamation"></i> Nenhum preço completo</span>'}</footer>
      </article>`).join('')}</div>`;
      const notes=`<div class="compare-truth-note"><i class="fa-solid fa-circle-info"></i><div><b>Como o destaque é calculado</b><span>O verde marca o menor total confirmado para a quantidade completa da peça. Estoque parcial não vence. O frete fixo não é rateado por peça; ele é somado uma única vez no total “Compra pelos menores”.</span></div></div>`;
      const extra=`<details class="compare-more"><summary>Backup e limpeza</summary><div class="compare-simple-actions"><button class="btn line" onclick="Comparator.exportJSON()"><i class="fa-solid fa-file-export"></i> Exportar comparação</button><label class="btn line" for="compareImport"><i class="fa-solid fa-file-import"></i> Importar comparação</label><input id="compareImport" class="compare-file" type="file" accept="application/json" onchange="Comparator.importJSON(this)"><button class="btn bad" onclick="Comparator.clearAll()"><i class="fa-solid fa-trash"></i> Limpar tudo</button></div></details>`;
      box.innerHTML=actions+summary+supplierStrip+desktop+mobile+notes+extra;
    },
    comparisonPdfName(){
      const vehicle=(this.state.vehicle||'comparacao').replace(/[^a-zA-Z0-9À-ÿ]+/g,'_').replace(/^_+|_+$/g,'').slice(0,60)||'comparacao';
      return `Comparacao_Precos_${vehicle}.pdf`;
    },
    createComparisonPDF(){
      const jsPDFClass=window.jspdf?.jsPDF;
      if(!jsPDFClass || !jsPDFClass.API?.autoTable){throw new Error('Biblioteca de PDF não carregada.');}
      const result=this.computeResult();
      if(!result.confirmed.length) throw new Error('Ainda não existem preços conferidos para gerar o PDF.');
      this.ensureThreeSuppliers();
      const doc=new jsPDFClass('l','mm','a4');
      const navy=[17,24,39],green=[22,101,52],lightGreen=[220,252,231],lightYellow=[255,251,235],lightRed=[254,242,242],gray=[100,116,139];
      doc.setFont('helvetica','bold');doc.setFontSize(15);doc.setTextColor(...navy);doc.text('COMPARAÇÃO DE PREÇOS DE PEÇAS',14,14);
      doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(...gray);
      doc.text(`Veículo / aplicação: ${this.state.vehicle||'Não informado'}`,14,20);
      doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`,14,25);
      doc.text('Somente preços conferidos e salvos entram nesta comparação.',14,30);
      const head=[['PEÇA / QTD',...this.state.suppliers.map((s,i)=>`FORNECEDOR ${i+1}\n${s.name}`),'MELHOR OPÇÃO']];
      const body=result.items.map((item,index)=>{
        const row=[{content:`${index+1}. ${item.request.description}\nQtd. necessária: ${item.request.qty}`,styles:{fontStyle:'bold',valign:'middle'}}];
        this.state.suppliers.forEach(s=>{
          const offers=this.itemOffersForSupplier(item,s);
          if(!s.confirmed){row.push({content:'AGUARDANDO\nNenhum preço salvo',styles:{textColor:gray,valign:'middle'}});return;}
          if(!offers.length){row.push({content:'NÃO RESPONDEU\nEsta peça não foi cotada',styles:{textColor:gray,valign:'middle'}});return;}
          const hasWinner=offers.some(o=>item.winner&&o.supplierId===item.winner.supplierId&&o.source?.id===item.winner.source?.id);
          const hasPartial=offers.some(o=>o.partial);
          const onlyUnavailable=offers.every(o=>o.unavailable);
          const text=offers.map(o=>{
            if(o.unavailable) return `${o.brand||'SEM MARCA'} — NÃO TEM`;
            const parts=[o.brand||'SEM MARCA',`${this.money(o.unitCost)} cada`,`${this.money(o.total)} total`];
            if(o.code)parts.push(`Cód. ${o.code}`);
            if(o.partial)parts.push(`PARCIAL: ${o.offeredQty} de ${o.requiredQty}`);
            if(item.winner&&o.supplierId===item.winner.supplierId&&o.source?.id===item.winner.source?.id)parts.push('MAIS BARATO');
            return parts.join(' | ');
          }).join('\n\n');
          const styles={valign:'middle'};
          if(hasWinner){styles.fillColor=lightGreen;styles.textColor=green;styles.fontStyle='bold';}
          else if(hasPartial){styles.fillColor=lightYellow;}
          else if(onlyUnavailable){styles.fillColor=lightRed;}
          row.push({content:text,styles});
        });
        row.push(item.winner?{content:`${item.winner.supplierName}\n${item.winner.brand||'SEM MARCA'}\n${this.money(item.winner.total)} total\n${this.money(item.winner.unitCost)} cada`,styles:{fillColor:lightGreen,textColor:green,fontStyle:'bold',valign:'middle'}}:{content:'SEM PREÇO COMPLETO',styles:{fillColor:lightRed,textColor:[153,27,27],fontStyle:'bold',valign:'middle'}});
        return row;
      });
      doc.autoTable({
        startY:35,head,body,theme:'grid',
        headStyles:{fillColor:navy,textColor:[255,255,255],fontSize:7,fontStyle:'bold',halign:'center',valign:'middle',cellPadding:2},
        styles:{font:'helvetica',fontSize:6.5,cellPadding:2,lineColor:[203,213,225],lineWidth:.2,overflow:'linebreak'},
        columnStyles:{0:{cellWidth:48},1:{cellWidth:54},2:{cellWidth:54},3:{cellWidth:54},4:{cellWidth:47}},
        margin:{left:14,right:14,top:14,bottom:18},
        rowPageBreak:'avoid'
      });
      let y=doc.lastAutoTable.finalY+7;
      if(y>170){doc.addPage();y=16;}
      doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(...navy);doc.text('RESUMO',14,y);
      doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(0);
      doc.text(`Itens com menor preço completo: ${result.winners.length} de ${this.state.requested.length}`,14,y+6);
      doc.text(`Itens ainda sem preço completo: ${result.missing}`,14,y+11);
      doc.setFont('helvetica','bold');doc.setTextColor(...green);doc.text(`Compra pelos menores preços: ${result.winners.length?this.money(result.mixedTotal):'—'}`,14,y+17);
      doc.setFont('helvetica','normal');doc.setTextColor(...gray);doc.setFontSize(7);
      doc.text(`Fretes fixos incluídos uma única vez: ${this.money(result.mixedFreight)}. O menor preço por peça não rateia frete fixo.`,14,y+23);
      const pages=doc.internal.getNumberOfPages();
      for(let i=1;i<=pages;i++){
        doc.setPage(i);doc.setFontSize(7);doc.setTextColor(...gray);
        doc.text(`Powered by thIAguinho Soluções Digitais — Página ${i}/${pages}`,148.5,205,{align:'center'});
      }
      return {doc,fileName:this.comparisonPdfName(),blob:doc.output('blob')};
    },
    generateComparisonPDF(){
      try{
        const pdf=this.createComparisonPDF();
        this.lastComparisonPdfBlob=pdf.blob;
        pdf.doc.save(pdf.fileName);
        this.toast('PDF da comparação gerado.');
      }catch(error){this.toast(error.message||'Não foi possível gerar o PDF da comparação.');}
    },
    async shareComparisonPDF(){
      try{
        const pdf=this.createComparisonPDF();
        this.lastComparisonPdfBlob=pdf.blob;
        const file=new File([pdf.blob],pdf.fileName,{type:'application/pdf'});
        if(navigator.canShare&&navigator.canShare({files:[file]})){
          await navigator.share({title:'Comparação de preços',text:`Comparação de preços — ${this.state.vehicle||'veículo não informado'}`,files:[file]});
        }else{
          pdf.doc.save(pdf.fileName);
          this.toast('O navegador não compartilha arquivos diretamente. O PDF foi baixado para você anexar.');
        }
      }catch(error){
        if(error?.name!=='AbortError')this.toast(error.message||'Não foi possível compartilhar o PDF.');
      }
    },
    addWinnersToBudget(){
      const app=this.app(),result=this.computeResult();
      if(!app||typeof app.addPart!=='function'){this.toast('O orçamento principal não está disponível.');return;}
      if(!result.winners.length){this.toast('Ainda não existe nenhum menor preço para levar ao orçamento.');return;}
      const raw=prompt('Percentual de acréscimo sobre o custo. Digite 0 para não acrescentar:','0');
      if(raw===null)return;
      const markup=Math.max(0,this.num(raw));
      const missingText=result.missing?` Existem ${result.missing} item(ns) ainda sem preço e eles não serão adicionados.`:'';
      if(!this.confirm(`Adicionar ${result.winners.length} peça(s) com menor preço ao orçamento, usando ${markup}% de acréscimo?${missingText}`))return;
      result.winners.forEach(w=>app.addPart({descricao:w.description,qtd:w.requiredQty,valorUnit:w.unitCost*(1+markup/100),fornecedor:[w.brand,w.supplierName].filter(Boolean).join(' | '),cod:w.code||'',desc:0}));
      if(typeof app.saveLocal==='function')app.saveLocal(false);
      if(typeof app.show==='function')app.show('secItens');
      this.toast(`${result.winners.length} peça(s) adicionada(s) ao orçamento.`);
    },
    exportJSON(){
      const blob=new Blob([JSON.stringify(this.state,null,2)],{type:'application/json'}),a=document.createElement('a');
      a.href=URL.createObjectURL(blob);a.download='comparacao_precos.json';a.click();URL.revokeObjectURL(a.href);
    },
    importJSON(input){
      const file=input?.files?.[0];if(!file)return;
      const reader=new FileReader();
      reader.onload=()=>{try{const data=JSON.parse(reader.result);this.state=Object.assign(this.defaultState(),data);this.$('compareVehicle').value=this.state.vehicle||'';this.$('compareRequestText').value=this.state.requestText||'';this.renderAll();this.toast('Comparação importada.');}catch(e){this.toast('Arquivo inválido.');}input.value='';};
      reader.readAsText(file);
    },
    clearAll(){
      if(!this.confirm('Apagar somente a comparação de preços? O orçamento principal será preservado.'))return;
      this.state=this.defaultState();
      localStorage.removeItem(this.STORAGE_KEY);
      this.LEGACY_KEYS.forEach(key=>localStorage.removeItem(key));
      this.$('compareVehicle').value='';this.$('compareRequestText').value='';this.renderAll();this.toast('Comparação limpa.');
    }
  };

  window.Comparator=Comparator;
  window.addEventListener('DOMContentLoaded',()=>Comparator.init());
})();
