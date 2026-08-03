/*
  Comparador Inteligente de Preços — módulo isolado para SOS Orçamentos IA.
  Não substitui nem remove as rotinas existentes de orçamento, áudio, preview ou PDF.
*/
(function(){
  'use strict';

  const Comparator = {
    STORAGE_KEY:'sos_comparador_precos_v1',
    state:{
      version:1,
      vehicle:'',
      requestText:'',
      requested:[],
      suppliers:[],
      forcedOffers:{},
      selectedPlanKey:'best',
      lastResult:null,
      activeResultTab:'plans'
    },
    busySuppliers:new Set(),

    $(id){return document.getElementById(id);},
    esc(value){return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));},
    attr(value){return this.esc(value).replace(/`/g,'&#96;');},
    num(value){return window.App&&App.num?App.num(value):(Number(String(value??'').replace(',','.'))||0);},
    money(value){return window.App&&App.money?App.money(value):(Number(value)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});},
    toast(message){if(window.App&&App.toast)App.toast(message);else alert(message);},
    id(prefix='id'){
      if(window.crypto&&crypto.randomUUID)return prefix+'_'+crypto.randomUUID().replace(/-/g,'').slice(0,14);
      return prefix+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    },
    plain(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();},
    cleanDescription(value){return String(value??'').replace(/^[\s\-–—•*]+/,'').replace(/\s+/g,' ').trim();},
    parseAvailability(value){
      const p=this.plain(value);
      if(/NAO VAI|NAO TEM|SEM ESTOQUE|INDISPONIVEL|ESGOTADO/.test(p))return 'unavailable';
      if(/SO TEM|SOMENTE|PARCIAL/.test(p))return 'partial';
      if(/DISPONIVEL|TEMOS|PRONTA ENTREGA/.test(p))return 'available';
      return 'unknown';
    },
    wordsToNumber(value){
      const p=this.plain(value);
      const map={UM:1,UMA:1,DOIS:2,DUAS:2,PAR:2,TRES:3,QUATRO:4,CINCO:5,SEIS:6,SETE:7,OITO:8,NOVE:9,DEZ:10};
      const first=p.split(' ')[0];
      if(map[first])return map[first];
      const m=p.match(/^(\d+(?:[.,]\d+)?)/);
      return m?this.num(m[1]):0;
    },
    knownBrands(){return ['LUK','VALEO','FANIA','MONROE','MONROE','COFAP','AXIOS','NAKATA','SABO','SABÓ','SPICER','CORTECO','MOBENSANI','PERFECT','BROKITS','BROKIT','EFFARI','MORBE','MORBE?','NYTRON','SKF','INA','TRW','VIEMAR'];},
    extractBrand(line){
      const p=this.plain(line);
      const brands=this.knownBrands();
      return brands.find(b=>p.includes(this.plain(b)))||'';
    },
    normalizeForMatch(value){
      let p=this.plain(value);
      const replacements=[
        [/\bPNEUZINHOS?\b/g,' BUCHA BARRA ESTABILIZADORA '],
        [/\bCOIFA RODA\b/g,' COIFA HOMOCINETICA EXTERNA '],
        [/\bCOIFA CAMBIO\b/g,' COIFA HOMOCINETICA INTERNA '],
        [/\bRETENTOR MANCAL\b/g,' RETENTOR VIRABREQUIM TRASEIRO FLANGE '],
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
        [/\bEMBREAGENS\b/g,' EMBREAGEM '],
        [/\bMORCEGUINHOS?\b/g,' LIGACAO BARRA ']
      ];
      replacements.forEach(([re,to])=>{p=p.replace(re,to)});
      return p.replace(/\s+/g,' ').trim();
    },
    requestMatchText(request){
      const note=this.plain(request?.notes||'');
      const ctx=[];
      if(/DIANTEIR|APOS AMORTECEDOR DIANTEIRO/.test(note))ctx.push('DIANTEIRO');
      if(/TRASEIR|APOS AMORTECEDOR TRASEIRO/.test(note))ctx.push('TRASEIRO');
      if(/INTERNA|CAMBIO/.test(note))ctx.push('INTERNA');
      if(/EXTERNA|RODA/.test(note))ctx.push('EXTERNA');
      return `${request?.description||''} ${ctx.join(' ')}`.trim();
    },
    isGenericRequest(request){
      const p=this.plain(request?.description||'');
      return ['KIT','PECA','ITEM','BUCHA','RETENTOR','COIFA'].includes(p)||p.length<4;
    },
    features(value){
      const p=this.normalizeForMatch(value);
      const tokens=p.split(' ').filter(w=>w.length>2&&!['PARA','COM','SEM','TIPO','LADO','CADA','PECA','PECAS','UNIDADE','UNIDADES','KIT'].includes(w));
      let concept='';
      if(/CABO.*EMBREAGEM|EMBREAGEM.*CABO/.test(p))concept='CABO_EMBREAGEM';
      else if(/EMBREAGEM/.test(p))concept='EMBREAGEM';
      else if(/RETENTOR/.test(p)&&/(MANCAL|VIRABREQUIM|FLANGE)/.test(p))concept='RETENTOR_MANCAL';
      else if(/COIFA/.test(p)&&/(EXTERNA|RODA)/.test(p))concept='COIFA_EXTERNA';
      else if(/COIFA/.test(p)&&/(INTERNA|CAMBIO)/.test(p))concept='COIFA_INTERNA';
      else if(/AMORTECEDOR/.test(p)&&/(KIT|BATENTE|COXIM)/.test(p))concept='KIT_AMORTECEDOR';
      else if(/AMORTECEDOR/.test(p))concept='AMORTECEDOR';
      else if(/BRACO OSCILANTE/.test(p))concept='BRACO_OSCILANTE';
      else if(/BUCHA.*BANDEJA|BANDEJA.*BUCHA/.test(p))concept='BUCHA_BANDEJA';
      else if(/PIVO/.test(p))concept='PIVO';
      else if(/TERMINAL.*BARRA|LIGACAO.*BARRA/.test(p))concept='LIGACAO_BARRA';
      else if(/BUCHA.*BARRA|BARRA.*BUCHA/.test(p))concept='BUCHA_BARRA';
      else if(/\bKIT\b/.test(p))concept='KIT_GENERICO';
      return {
        p,tokens:[...new Set(tokens)],concept,
        front:/DIANTEIRO/.test(p),rear:/TRASEIRO/.test(p),
        internal:/INTERNA|CAMBIO/.test(p),external:/EXTERNA|RODA/.test(p)
      };
    },
    contradiction(a,b){
      if((a.front&&b.rear)||(a.rear&&b.front))return true;
      if((a.internal&&b.external)||(a.external&&b.internal))return true;
      const hard=[
        ['EMBREAGEM','AMORTECEDOR'],['EMBREAGEM','COIFA'],['EMBREAGEM','BUCHA'],['EMBREAGEM','RETENTOR'],
        ['CABO_EMBREAGEM','EMBREAGEM'],['COIFA_INTERNA','COIFA_EXTERNA'],['BUCHA_BANDEJA','BUCHA_BARRA']
      ];
      return hard.some(([x,y])=>(a.concept===x&&b.concept===y)||(a.concept===y&&b.concept===x));
    },
    scoreMatch(request,offer,requestIndex=0,offerIndex=0,totalReq=1,totalOffers=1){
      const a=this.features(this.requestMatchText(request)),b=this.features(offer.description);
      if(!a.p||!b.p)return 0;
      if(this.contradiction(a,b))return 0.05;
      const A=new Set(a.tokens),B=new Set(b.tokens);
      const inter=[...A].filter(x=>B.has(x)).length;
      const union=new Set([...A,...B]).size||1;
      let score=(inter/union)*0.42;
      if(a.p===b.p)score+=0.52;
      else if(a.p.includes(b.p)||b.p.includes(a.p))score+=0.22;
      if(a.concept&&b.concept&&a.concept===b.concept){score+=0.46;score=Math.max(score,0.78);}
      else if(a.concept==='KIT_GENERICO'&&/KIT_AMORTECEDOR/.test(b.concept))score+=0.18;
      else if(b.concept==='KIT_GENERICO'&&/KIT_AMORTECEDOR/.test(a.concept))score+=0.18;
      else if(['PIVO','LIGACAO_BARRA','BUCHA_BARRA'].includes(a.concept)&&['PIVO','LIGACAO_BARRA','BUCHA_BARRA'].includes(b.concept))score+=0.25;
      if((a.front&&b.front)||(a.rear&&b.rear)||(a.internal&&b.internal)||(a.external&&b.external))score+=0.08;
      if(a.concept==='KIT_GENERICO'||b.concept==='KIT_GENERICO'){
        const pa=totalReq>1?requestIndex/(totalReq-1):0;
        const pb=totalOffers>1?offerIndex/(totalOffers-1):0;
        score+=Math.max(0,0.16-Math.abs(pa-pb)*0.16);
      }
      return Math.max(0,Math.min(1,score));
    },

    defaultState(){return {version:1,vehicle:'',requestText:'',requested:[],suppliers:[],forcedOffers:{},selectedPlanKey:'best',lastResult:null,activeResultTab:'plans'};},
    save(){
      try{localStorage.setItem(this.STORAGE_KEY,JSON.stringify({...this.state,lastResult:null}));}
      catch(e){console.warn('Falha ao salvar comparador',e);}
      const status=this.$('compareSaveStatus');if(status)status.textContent='Comparação salva localmente';
    },
    load(){
      try{
        const raw=localStorage.getItem(this.STORAGE_KEY);
        if(!raw)return;
        const parsed=JSON.parse(raw);
        this.state=Object.assign(this.defaultState(),parsed||{});
        if(!Array.isArray(this.state.requested))this.state.requested=[];
        if(!Array.isArray(this.state.suppliers))this.state.suppliers=[];
        if(!this.state.forcedOffers||typeof this.state.forcedOffers!=='object')this.state.forcedOffers={};
      }catch(e){console.warn('Falha ao carregar comparador',e);this.state=this.defaultState();}
    },
    init(){
      if(!this.$('secComparador'))return;
      this.load();
      this.$('compareVehicle').value=this.state.vehicle||'';
      this.$('compareRequestText').value=this.state.requestText||'';
      this.$('compareVehicle').addEventListener('input',()=>{this.state.vehicle=this.$('compareVehicle').value;this.save();});
      this.$('compareRequestText').addEventListener('input',()=>{this.state.requestText=this.$('compareRequestText').value;this.save();});
      this.renderAll();
    },
    renderAll(){
      this.markDuplicates();
      this.matchAll(false);
      this.renderRequested();
      this.renderSuppliers();
      this.renderResults();
      this.save();
    },

    parseRequestedLocal(text){
      const lines=String(text||'').split(/\r?\n|;/).map(x=>this.cleanDescription(x)).filter(Boolean);
      let vehicle=this.state.vehicle||'';
      const items=[];
      lines.forEach((line,idx)=>{
        if(idx===0&&!/^[-•*]|^(\d+|UM|UMA|DOIS|DUAS|PAR)\b/i.test(String(text||'').split(/\r?\n/)[0]||'')&&/\d{4}|UNO|GOL|PALIO|CORSA|FIAT|VW|VOLKSWAGEN|FORD|CHEVROLET|RENAULT|HONDA|TOYOTA/i.test(line)){
          vehicle=vehicle||line;return;
        }
        let cleaned=line.replace(/^[\-–—•*]+\s*/,'').trim();
        if(!cleaned)return;
        let qty=this.wordsToNumber(cleaned)||1;
        cleaned=cleaned.replace(/^(?:\d+(?:[.,]\d+)?|UM|UMA|DOIS|DUAS|PAR|TRES|TRÊS|QUATRO|CINCO|SEIS|SETE|OITO|NOVE|DEZ)\s+/i,'').trim();
        if(!cleaned)return;
        items.push({id:this.id('req'),order:items.length,description:cleaned,qty,unit:'PC',notes:'',possibleDuplicate:false});
      });
      return {vehicle,items};
    },
    async parseRequest(){
      const text=this.$('compareRequestText').value.trim();
      if(!text){this.toast('Cole a lista de peças solicitadas.');return;}
      this.state.requestText=text;
      const key=this.getGroqKey();
      let parsed;
      if(key){
        this.setGlobalBusy(true,'IA interpretando a lista solicitada...');
        try{parsed=await this.parseRequestedAI(text,key);}
        catch(e){console.warn(e);parsed=this.parseRequestedLocal(text);this.toast('A IA não respondeu. A lista foi interpretada pelo modo local.');}
        finally{this.setGlobalBusy(false);}
      }else parsed=this.parseRequestedLocal(text);
      if(parsed.vehicle&&!this.$('compareVehicle').value)this.$('compareVehicle').value=parsed.vehicle;
      this.state.vehicle=this.$('compareVehicle').value||parsed.vehicle||'';
      this.state.requested=(parsed.items||[]).map((item,index)=>({
        id:item.id||this.id('req'),order:index,description:this.cleanDescription(item.description||item.descricao),qty:this.num(item.qty||item.quantidade)||1,unit:item.unit||'PC',notes:item.notes||item.observacao||'',possibleDuplicate:false
      })).filter(x=>x.description);
      this.state.forcedOffers={};
      this.matchAll(true);
      this.renderAll();
      this.toast(`${this.state.requested.length} item(ns) solicitado(s) interpretado(s).`);
    },
    async parseRequestedAI(text,key){
      const schema={vehicle:'',items:[{description:'',qty:1,unit:'PC',notes:''}]};
      const prompt=`Extraia fielmente uma lista de peças automotivas solicitadas. Retorne SOMENTE JSON válido no formato ${JSON.stringify(schema)}.
REGRAS OBRIGATÓRIAS:
1. Não invente peças, quantidades, aplicações, marcas ou lados.
2. Preserve itens repetidos como linhas separadas. Quando parecer duplicado, escreva isso apenas em notes, sem apagar.
3. O primeiro texto pode ser o veículo; coloque em vehicle.
4. Quantidade ausente = 1.
5. Expressões genéricas como "2 kits" devem continuar genéricas. Use notes para indicar apenas o contexto textual, por exemplo "após amortecedores dianteiros", sem afirmar que é kit dianteiro.
6. Não extraia preços.
TEXTO REAL:\n${text}`;
      const content=await this.groqText(prompt,key);
      const json=this.extractJSON(content);
      return {vehicle:json.vehicle||'',items:Array.isArray(json.items)?json.items:[]};
    },
    loadBudgetParts(){
      const parts=window.App&&Array.isArray(App.state?.parts)?App.state.parts:[];
      if(!parts.length){this.toast('O orçamento atual não possui peças.');return;}
      if(this.state.requested.length&&!confirm('Substituir a lista solicitada atual pelas peças do orçamento?'))return;
      this.state.requested=parts.map((p,index)=>({id:this.id('req'),order:index,description:p.descricao||'PEÇA',qty:this.num(p.qtd)||1,unit:'PC',notes:'Importado do orçamento atual',possibleDuplicate:false}));
      this.state.requestText=this.state.requested.map(x=>`- ${x.qty} ${x.description}`).join('\n');
      this.$('compareRequestText').value=this.state.requestText;
      this.matchAll(true);this.renderAll();this.toast('Peças do orçamento importadas para comparação.');
    },
    addRequested(){
      this.state.requested.push({id:this.id('req'),order:this.state.requested.length,description:'NOVA PEÇA',qty:1,unit:'PC',notes:'',possibleDuplicate:false});
      this.renderAll();
    },
    updateRequested(id,field,value){
      const item=this.state.requested.find(x=>x.id===id);if(!item)return;
      item[field]=field==='qty'?Math.max(0.01,this.num(value)||1):value;
      this.matchAll(true);this.renderAll();
    },
    removeRequested(id){
      if(!confirm('Excluir este item da lista solicitada?'))return;
      this.state.requested=this.state.requested.filter(x=>x.id!==id).map((x,i)=>({...x,order:i}));
      delete this.state.forcedOffers[id];
      this.state.suppliers.forEach(s=>s.offers.forEach(o=>{if(o.requestedId===id){o.requestedId='';o.matchMethod='';o.matchStatus='unmatched';}}));
      this.renderAll();
    },
    markDuplicates(){
      const groups={};
      this.state.requested.forEach(x=>{
        x.possibleDuplicate=false;
        const f=this.features(this.requestMatchText(x));
        const k=this.normalizeForMatch(x.description)+'|'+(f.front?'F':'')+(f.rear?'R':'')+(f.internal?'I':'')+(f.external?'E':'');
        (groups[k]||(groups[k]=[])).push(x);
      });
      Object.values(groups).forEach(list=>{if(list.length>1)list.forEach(x=>x.possibleDuplicate=true);});
    },

    addSupplier(){
      const supplier={id:this.id('sup'),name:`FORNECEDOR ${this.state.suppliers.length+1}`,phone:'',freight:0,payment:'',documentTotal:0,documentExtra:0,sourceText:'',sourceNote:'',imageName:'',offers:[]};
      this.state.suppliers.push(supplier);this.renderAll();
    },
    removeSupplier(id){
      if(!confirm('Excluir este fornecedor e todos os preços lançados?'))return;
      const offerIds=new Set((this.state.suppliers.find(s=>s.id===id)?.offers||[]).map(o=>o.id));
      Object.keys(this.state.forcedOffers).forEach(k=>{if(offerIds.has(this.state.forcedOffers[k]))delete this.state.forcedOffers[k];});
      this.state.suppliers=this.state.suppliers.filter(s=>s.id!==id);this.renderAll();
    },
    supplier(id){return this.state.suppliers.find(s=>s.id===id);},
    offerById(id){for(const s of this.state.suppliers){const o=s.offers.find(x=>x.id===id);if(o)return {supplier:s,offer:o};}return null;},
    updateSupplier(id,field,value){
      const s=this.supplier(id);if(!s)return;
      s[field]=['freight','documentTotal','documentExtra'].includes(field)?this.num(value):value;
      this.renderResults();this.save();
    },
    addOffer(supplierId){
      const s=this.supplier(supplierId);if(!s)return;
      s.offers.push(this.normalizeOffer({description:'NOVA PEÇA',qtyOffered:1,unitPrice:0,priceBasis:'unit',availability:'unknown',requestedId:'',matchMethod:'manual'},s));
      this.matchSupplier(s,true);this.renderAll();
    },
    removeOffer(supplierId,offerId){
      const s=this.supplier(supplierId);if(!s)return;
      s.offers=s.offers.filter(o=>o.id!==offerId);
      Object.keys(this.state.forcedOffers).forEach(k=>{if(this.state.forcedOffers[k]===offerId)delete this.state.forcedOffers[k];});
      this.renderAll();
    },
    updateOffer(supplierId,offerId,field,value){
      const s=this.supplier(supplierId),o=s?.offers.find(x=>x.id===offerId);if(!o)return;
      if(['qtyOffered','unitPrice','lineTotal','lineExtra'].includes(field))o[field]=this.num(value);
      else o[field]=value;
      if(field==='requestedId'){o.matchMethod='manual';o.matchStatus=value?'ok':'unmatched';o.matchScore=value?1:0;}
      if(field==='description'&&o.matchMethod!=='manual'){o.requestedId='';o.matchStatus='unmatched';}
      this.matchSupplier(s,false);this.renderAll();
    },
    normalizeOffer(raw,supplier){
      const basis=['unit','total','ambiguous'].includes(raw.priceBasis)?raw.priceBasis:'unit';
      const availability=['available','partial','unavailable','unknown'].includes(raw.availability)?raw.availability:'unknown';
      return {
        id:raw.id||this.id('off'),order:Number.isFinite(raw.order)?raw.order:(supplier?.offers?.length||0),
        description:this.cleanDescription(raw.description||raw.descricao||''),brand:this.cleanDescription(raw.brand||raw.marca||''),code:this.cleanDescription(raw.code||raw.codigo||''),
        qtyOffered:this.num(raw.qtyOffered??raw.quantidade??raw.qtd)||0,
        unitPrice:this.num(raw.unitPrice??raw.precoUnitario??raw.valorUnit)||0,
        lineTotal:this.num(raw.lineTotal??raw.totalLinha??raw.valorTotal)||0,
        lineExtra:this.num(raw.lineExtra??raw.extraLinha??raw.freteSt)||0,
        priceBasis:basis,availability,notes:this.cleanDescription(raw.notes||raw.observacao||''),
        requestedId:raw.requestedId||'',matchScore:this.num(raw.matchScore)||0,matchStatus:raw.matchStatus||'unmatched',matchMethod:raw.matchMethod||'',rawLine:raw.rawLine||''
      };
    },
    splitLines(text){return String(text||'').split(/\r?\n|;/).map(x=>this.cleanDescription(x)).filter(Boolean);},
    parseOffersLocal(text,supplier){
      const offers=[];
      const lines=this.splitLines(text);
      lines.forEach((raw,index)=>{
        let line=raw.replace(/^[\-–—•*]+\s*/,'').trim();
        if(!line)return;
        const availability=this.parseAvailability(line);
        const partial=line.match(/s[oó]\s+tem\s+(\d+(?:[.,]\d+)?)/i);
        const looksLikeVehicle=/\b(UNO|GOL|PALIO|CORSA|FIAT|VOLKSWAGEN|VW|FORD|CHEVROLET|RENAULT|HONDA|TOYOTA)\b/i.test(line)&&/\b(?:19|20)\d{2}\b/.test(line);
        if(looksLikeVehicle&&!/R\$|CADA|REAIS?|PRE[CÇ]O/i.test(line))return;
        const priceLine=line.replace(/s[oó]\s+tem\s+\d+(?:[.,]\d+)?/ig,' ');
        const moneyMatches=[...priceLine.matchAll(/(?:R\$\s*)?(\d{1,7}(?:[.,]\d{1,2})?)/g)];
        if(!moneyMatches.length&&availability==='unknown')return;
        const last=moneyMatches[moneyMatches.length-1];
        const price=last?this.num(last[1]):0;
        let qty=this.wordsToNumber(line)||0;
        if(partial)qty=this.num(partial[1]);
        const each=/\b(cada|unit[aá]rio|por\s+unidade|por\s+pe[cç]a)\b/i.test(line);
        const totalWord=/\b(total|conjunto|par\s+por)\b/i.test(line);
        let basis='unit';
        if(qty>1&&!each&&!totalWord)basis='ambiguous';
        else if(totalWord&&qty>1)basis='total';
        const brand=this.extractBrand(line);
        let desc=line;
        if(last)desc=desc.slice(0,last.index)+desc.slice((last.index||0)+last[0].length);
        desc=desc.replace(/^(?:\d+(?:[.,]\d+)?|UM|UMA|DOIS|DUAS|PAR|TRES|TRÊS|QUATRO|CINCO|SEIS|SETE|OITO|NOVE|DEZ)\s+/i,'')
          .replace(/\b(cada|unit[aá]rio|por\s+unidade|por\s+pe[cç]a|reais?|s[oó]\s+tem\s+\d+|n[aã]o\s+vai|n[aã]o\s+tem)\b/ig,' ');
        if(brand)desc=desc.replace(new RegExp('\\b'+brand.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','ig'),' ');
        desc=desc.replace(/\s+/g,' ').trim();
        if(!desc)desc='ITEM NÃO IDENTIFICADO';
        offers.push(this.normalizeOffer({order:index,description:desc,brand,qtyOffered:qty,unitPrice:basis==='unit'?price:0,lineTotal:basis==='total'||basis==='ambiguous'?price:0,priceBasis:basis,availability,notes:partial?`Quantidade parcial informada: ${qty}`:'',rawLine:raw},supplier));
      });
      return {offers,documentTotal:0,documentExtra:0,observedText:text};
    },
    getGroqKey(){
      try{return window.App&&App.getGroqKey?App.getGroqKey():(window.OS_API?.getGroqKey?.()||window.SOS_CONFIG?.GROQ_API_KEY||'');}
      catch(e){return '';}
    },
    getTextModel(){return window.SOS_CONFIG?.GROQ_CHAT_MODEL||'openai/gpt-oss-20b';},
    getVisionModel(){return window.SOS_CONFIG?.GROQ_VISION_MODEL||'qwen/qwen3.6-27b';},
    async groqText(prompt,key){
      const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.getTextModel(),temperature:0,max_completion_tokens:6000,messages:[{role:'system',content:'Você extrai dados de cotações automotivas com fidelidade absoluta. Nunca invente valores, marcas, quantidades ou correspondências.'},{role:'user',content:prompt}]})});
      const data=await res.json();if(!res.ok)throw new Error(data.error?.message||`Erro Groq ${res.status}`);
      return data.choices?.[0]?.message?.content||'';
    },
    async groqVision(prompt,dataUrl,key){
      const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.getVisionModel(),temperature:0,max_completion_tokens:7000,messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:dataUrl}}]}]})});
      const data=await res.json();if(!res.ok)throw new Error(data.error?.message||`Erro Groq Vision ${res.status}`);
      return data.choices?.[0]?.message?.content||'';
    },
    extractJSON(content){
      let text=String(content||'').replace(/```json|```/gi,'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
      const first=text.indexOf('{'),last=text.lastIndexOf('}');
      if(first>=0&&last>first)text=text.slice(first,last+1);
      try{return JSON.parse(text);}catch(e){
        text=text.replace(/,\s*([}\]])/g,'$1');
        try{return JSON.parse(text);}catch(e2){throw new Error('A IA não devolveu JSON válido.');}
      }
    },
    requestedContext(){return this.state.requested.map((r,i)=>({id:r.id,ordem:i+1,descricao:r.description,quantidade:r.qty,observacao:r.notes||''}));},
    offerSchema(){return {documentTotal:0,documentExtra:0,observedText:'',offers:[{description:'',brand:'',code:'',qtyOffered:0,unitPrice:0,lineTotal:0,lineExtra:0,priceBasis:'unit',availability:'unknown',notes:'',requestedId:''}]};},
    offerPrompt(sourceKind,text=''){
      return `Extraia fielmente uma cotação de peças automotivas e retorne SOMENTE JSON válido no formato ${JSON.stringify(this.offerSchema())}.
LISTA SOLICITADA COM IDS:\n${JSON.stringify(this.requestedContext())}
REGRAS ABSOLUTAS:
1. Não invente item, marca, código, quantidade, preço, frete, ST ou disponibilidade.
2. Preserve alternativas de marca como ofertas separadas.
3. requestedId só pode ser preenchido quando a correspondência for tecnicamente clara. Em dúvida, deixe vazio.
4. Não trate "bucha barra estabilizadora", "terminal de barra", "pivô" e "braço oscilante" como a mesma peça.
5. Não trate peça dianteira como traseira, nem coifa interna como externa.
6. priceBasis: "unit" quando o preço é unitário/coluna pr.unit/cada; "total" quando é total do conjunto/linha; "ambiguous" quando o texto não permite saber.
7. availability: "available", "partial", "unavailable" ou "unknown". "só tem 4" = partial e qtyOffered 4. "não vai" = unavailable.
8. Em tabela/foto: leia os cabeçalhos. Coluna pr.unit é unitPrice; vlr total é lineTotal; frete+st da linha é lineExtra. documentTotal é o total final mostrado; documentExtra é o total de frete/ST mostrado separadamente.
9. Se a imagem ou texto estiver ilegível, deixe campos vazios e explique em notes; nunca adivinhe.
10. observedText deve conter uma transcrição resumida e fiel do que foi lido.
VEÍCULO/CONTEXTO: ${this.state.vehicle||'não informado'}
FONTE: ${sourceKind}${text?`\nTEXTO REAL:\n${text}`:''}`;
    },
    async processSupplierText(id){
      const s=this.supplier(id);if(!s)return;
      const text=(this.$(`supplierText_${id}`)?.value??s.sourceText??'').trim();
      if(!text){this.toast('Cole a resposta do fornecedor.');return;}
      s.sourceText=text;
      this.setSupplierBusy(id,true,'Interpretando texto do fornecedor...');
      let parsed;
      try{
        const key=this.getGroqKey();
        if(key){const content=await this.groqText(this.offerPrompt('TEXTO',text),key);parsed=this.extractJSON(content);}
        else parsed=this.parseOffersLocal(text,s);
      }catch(e){console.warn(e);parsed=this.parseOffersLocal(text,s);this.toast('A IA falhou; foi aplicado o parser local e itens ambíguos ficaram marcados para revisão.');}
      finally{this.setSupplierBusy(id,false);}
      this.applyParsedOffers(s,parsed,'text');
      this.renderAll();
      this.toast(`${s.offers.length} oferta(s) extraída(s) de ${s.name}.`);
    },
    async processSupplierImage(id,input){
      const s=this.supplier(id),file=input?.files?.[0];if(!s||!file)return;
      const preview=this.$(`supplierPreview_${id}`);
      if(preview){preview.src=URL.createObjectURL(file);preview.classList.add('show');}
      s.imageName=file.name;
      const key=this.getGroqKey();
      if(!key){this.toast('A leitura de foto exige a chave Groq configurada. Você ainda pode lançar os itens manualmente ou colar o texto.');input.value='';return;}
      this.setSupplierBusy(id,true,'Lendo a foto e conferindo colunas...');
      try{
        const dataUrl=await this.imageToDataURL(file);
        const content=await this.groqVision(this.offerPrompt('FOTO/TABELA'),dataUrl,key);
        const parsed=this.extractJSON(content);
        this.applyParsedOffers(s,parsed,'image');
        this.renderAll();
        this.toast(`Foto de ${s.name} interpretada. Confira os vínculos amarelos antes de comprar.`);
      }catch(e){console.error(e);this.toast('Não foi possível ler a foto: '+e.message);}
      finally{this.setSupplierBusy(id,false);input.value='';}
    },
    imageToDataURL(file){
      return new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onerror=()=>reject(new Error('Falha ao abrir a imagem.'));
        reader.onload=()=>{
          const img=new Image();
          img.onerror=()=>reject(new Error('Imagem inválida.'));
          img.onload=()=>{
            const max=1800,scale=Math.min(1,max/Math.max(img.width,img.height));
            const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
            const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,canvas.width,canvas.height);
            resolve(canvas.toDataURL('image/jpeg',0.88));
          };
          img.src=reader.result;
        };
        reader.readAsDataURL(file);
      });
    },
    applyParsedOffers(s,parsed,method){
      const list=Array.isArray(parsed?.offers)?parsed.offers:[];
      s.documentTotal=this.num(parsed?.documentTotal)||s.documentTotal||0;
      s.documentExtra=this.num(parsed?.documentExtra)||0;
      s.sourceNote=parsed?.observedText||s.sourceNote||'';
      s.offers=list.map((raw,index)=>this.normalizeOffer({...raw,order:index,matchMethod:raw.requestedId?'ai':''},s)).filter(o=>o.description||o.unitPrice||o.lineTotal);
      this.matchSupplier(s,true);
    },

    matchAll(force=false){this.state.suppliers.forEach(s=>this.matchSupplier(s,force));},
    matchSupplier(s,force=false){
      const reqs=this.state.requested,offers=s.offers||[];
      offers.forEach((o,oi)=>{
        if(o.matchMethod==='manual'&&o.requestedId&&!force)return;
        const direct=o.requestedId&&reqs.find(r=>r.id===o.requestedId);
        if(direct){
          const score=this.scoreMatch(direct,o,direct.order,oi,reqs.length,offers.length);
          o.matchScore=Math.max(score,o.matchMethod==='ai'?0.76:score);
          const directConflict=this.contradiction(this.features(this.requestMatchText(direct)),this.features(o.description));
          o.matchStatus=(directConflict||this.isGenericRequest(direct))?'review':(o.matchScore>=0.66?'ok':'review');
          return;
        }
        const ranked=reqs.map((r,ri)=>({r,score:this.scoreMatch(r,o,ri,oi,reqs.length,offers.length)})).sort((a,b)=>b.score-a.score);
        const top=ranked[0],second=ranked[1];
        if(top&&top.score>=0.72&&(!second||top.score-second.score>=0.09)&&!this.isGenericRequest(top.r)){
          o.requestedId=top.r.id;o.matchScore=top.score;o.matchStatus='ok';o.matchMethod='auto';
        }else if(top&&top.score>=0.48){
          o.requestedId=top.r.id;o.matchScore=top.score;o.matchStatus='review';o.matchMethod='auto';
        }else{o.requestedId='';o.matchScore=top?.score||0;o.matchStatus='unmatched';o.matchMethod='auto';}
      });
    },
    pricePerUnit(offer){
      const qty=this.num(offer.qtyOffered)||1;
      if(offer.priceBasis==='ambiguous')return 0;
      let base=0;
      if(offer.priceBasis==='total')base=this.num(offer.lineTotal)/qty;
      else base=this.num(offer.unitPrice)||((this.num(offer.lineTotal)>0)?this.num(offer.lineTotal)/qty:0);
      if(base<=0)return 0;
      return base+(this.num(offer.lineExtra)/qty);
    },
    eligibleOffer(s,o,r){
      if(!r||o.requestedId!==r.id)return false;
      if(!(o.matchStatus==='ok'||o.matchMethod==='manual'))return false;
      if(o.availability==='unavailable'||o.priceBasis==='ambiguous')return false;
      return this.pricePerUnit(o)>0;
    },
    offerCapacity(o,r){
      const q=this.num(o.qtyOffered);
      if(q>0)return q;
      return this.num(r.qty)||1;
    },
    buildCandidates(){
      const map={};this.state.requested.forEach(r=>map[r.id]=[]);
      this.state.suppliers.forEach(s=>(s.offers||[]).forEach(o=>{
        const r=this.state.requested.find(x=>x.id===o.requestedId);
        if(this.eligibleOffer(s,o,r))map[r.id].push({supplier:s,offer:o,unitCost:this.pricePerUnit(o),capacity:this.offerCapacity(o,r)});
      }));
      Object.values(map).forEach(list=>list.sort((a,b)=>a.unitCost-b.unitCost));
      return map;
    },
    buildPlan(allowedSupplierIds,candidates,key,label){
      const allowed=new Set(allowedSupplierIds),allocations=[];let itemsTotal=0;const used=new Set();
      for(const r of this.state.requested){
        let remaining=this.num(r.qty)||1;
        let list=(candidates[r.id]||[]).filter(c=>allowed.has(c.supplier.id));
        const forcedId=this.state.forcedOffers[r.id];
        if(forcedId){
          const idx=list.findIndex(c=>c.offer.id===forcedId);
          if(idx>=0)list=[list[idx],...list.slice(0,idx),...list.slice(idx+1)];
        }
        for(const c of list){
          if(remaining<=0.0001)break;
          const take=Math.min(remaining,c.capacity||remaining);
          if(take<=0)continue;
          const total=take*c.unitCost;
          allocations.push({requestId:r.id,description:r.description,qty:take,supplierId:c.supplier.id,supplierName:c.supplier.name,offerId:c.offer.id,brand:c.offer.brand,code:c.offer.code,unitCost:c.unitCost,total,notes:c.offer.notes||''});
          remaining-=take;itemsTotal+=total;used.add(c.supplier.id);
        }
        if(remaining>0.0001)return null;
      }
      let freight=0;used.forEach(id=>{const s=this.supplier(id);freight+=this.num(s?.freight);});
      return {key,label,allocations,usedSupplierIds:[...used],itemsTotal,freight,total:itemsTotal+freight,complete:true};
    },
    computeResult(){
      const candidates=this.buildCandidates();
      const unresolved=this.state.requested.filter(r=>(candidates[r.id]||[]).length===0);
      const suppliers=this.state.suppliers;
      const singles=[];
      suppliers.forEach(s=>{const p=this.buildPlan([s.id],candidates,'single_'+s.id,`Tudo em ${s.name}`);if(p)singles.push(p);});
      singles.sort((a,b)=>a.total-b.total);
      let best=null;
      const n=suppliers.length;
      if(this.state.requested.length&&!unresolved.length&&n){
        if(n<=12){
          const max=1<<n;
          for(let mask=1;mask<max;mask++){
            const ids=[];for(let i=0;i<n;i++)if(mask&(1<<i))ids.push(suppliers[i].id);
            const p=this.buildPlan(ids,candidates,'mix_'+mask,'Compra combinada otimizada');
            if(p&&(!best||p.total<best.total-0.001||(Math.abs(p.total-best.total)<0.001&&p.usedSupplierIds.length<best.usedSupplierIds.length)))best=p;
          }
        }else best=this.buildPlan(suppliers.map(s=>s.id),candidates,'mix_all','Compra combinada otimizada');
      }
      if(best)best.label=best.usedSupplierIds.length===1?`Melhor compra em ${this.supplier(best.usedSupplierIds[0])?.name}`:'Compra combinada mais econômica';
      const reviewOffers=[];suppliers.forEach(s=>s.offers.forEach(o=>{if(o.matchStatus==='review'||o.priceBasis==='ambiguous'||o.matchStatus==='unmatched')reviewOffers.push({supplier:s,offer:o});}));
      const bestSingle=singles[0]||null;
      const savings=best&&bestSingle?bestSingle.total-best.total:0;
      return {candidates,unresolved,reviewOffers,best,bestSingle,singles,savings};
    },
    activePlan(result){
      if(!result)return null;
      if(this.state.selectedPlanKey==='best')return result.best;
      if(this.state.selectedPlanKey==='single')return result.bestSingle;
      return result.singles.find(p=>p.key===this.state.selectedPlanKey)||result.best;
    },
    selectPlan(key){this.state.selectedPlanKey=key;this.renderResults();this.save();},
    forceOffer(requestId,offerId){
      if(this.state.forcedOffers[requestId]===offerId)delete this.state.forcedOffers[requestId];
      else this.state.forcedOffers[requestId]=offerId;
      this.renderResults();this.save();
    },

    renderRequested(){
      const box=this.$('compareRequestedList');if(!box)return;
      if(!this.state.requested.length){box.innerHTML='<div class="compare-empty">Nenhuma peça solicitada foi interpretada.</div>';return;}
      box.innerHTML=this.state.requested.map((r,i)=>`<div class="compare-request-card">
        <div class="compare-request-head"><div><b>Item solicitado ${i+1}</b> ${r.possibleDuplicate?'<span class="compare-badge warn"><i class="fa-solid fa-triangle-exclamation"></i> possível duplicado</span>':''}</div><button class="btn bad small" onclick="Comparator.removeRequested('${r.id}')"><i class="fa-solid fa-trash"></i> Excluir</button></div>
        <div class="compare-offer-grid">
          <div class="col-2 mhalf"><label>Quantidade</label><input value="${this.attr(r.qty)}" inputmode="decimal" onchange="Comparator.updateRequested('${r.id}','qty',this.value)"></div>
          <div class="col-7"><label>Descrição solicitada</label><input value="${this.attr(r.description)}" onchange="Comparator.updateRequested('${r.id}','description',this.value)"></div>
          <div class="col-3"><label>Observação/contexto</label><input value="${this.attr(r.notes||'')}" onchange="Comparator.updateRequested('${r.id}','notes',this.value)"></div>
        </div>
      </div>`).join('');
    },
    matchBadge(o){
      if(o.matchMethod==='manual'&&o.requestedId)return '<span class="compare-badge manual">vínculo manual</span>';
      if(o.matchStatus==='ok')return `<span class="compare-badge ok">vínculo ${Math.round((o.matchScore||0)*100)}%</span>`;
      if(o.matchStatus==='review')return `<span class="compare-badge warn">revisar vínculo ${Math.round((o.matchScore||0)*100)}%</span>`;
      return '<span class="compare-badge bad">sem correspondência</span>';
    },
    availabilityOptions(value){return [['unknown','Não informado'],['available','Disponível'],['partial','Quantidade parcial'],['unavailable','Indisponível']].map(([v,l])=>`<option value="${v}" ${value===v?'selected':''}>${l}</option>`).join('');},
    basisOptions(value){return [['unit','Preço unitário'],['total','Preço total da linha'],['ambiguous','Preço ambíguo — revisar']].map(([v,l])=>`<option value="${v}" ${value===v?'selected':''}>${l}</option>`).join('');},
    requestOptions(value){return `<option value="">— Não vinculado —</option>`+this.state.requested.map((r,i)=>`<option value="${r.id}" ${value===r.id?'selected':''}>${i+1}. ${this.esc(r.description)} — qtd ${this.esc(r.qty)}</option>`).join('');},
    renderSuppliers(){
      const box=this.$('compareSuppliers');if(!box)return;
      if(!this.state.suppliers.length){box.innerHTML='<div class="compare-empty">Adicione um fornecedor para colar texto, enviar foto ou lançar preços manualmente.</div>';return;}
      box.innerHTML=this.state.suppliers.map((s,si)=>`<div class="compare-supplier-card">
        <div class="compare-supplier-head">
          <div><b>${si+1}. ${this.esc(s.name||'FORNECEDOR')}</b> <span class="compare-badge info">${s.offers.length} oferta(s)</span></div>
          <div class="btnrow"><button class="btn line small" onclick="Comparator.addOffer('${s.id}')"><i class="fa-solid fa-plus"></i> Item manual</button><button class="btn bad small" onclick="Comparator.removeSupplier('${s.id}')"><i class="fa-solid fa-trash"></i> Excluir fornecedor</button></div>
        </div>
        <div class="compare-supplier-meta">
          <div class="col-4"><label>Fornecedor</label><input value="${this.attr(s.name)}" onchange="Comparator.updateSupplier('${s.id}','name',this.value)"></div>
          <div class="col-3 mhalf"><label>WhatsApp</label><input value="${this.attr(s.phone||'')}" inputmode="tel" onchange="Comparator.updateSupplier('${s.id}','phone',this.value)"></div>
          <div class="col-2 mhalf"><label>Frete fixo</label><input value="${this.attr(s.freight||0)}" inputmode="decimal" onchange="Comparator.updateSupplier('${s.id}','freight',this.value)"></div>
          <div class="col-3"><label>Pagamento/prazo</label><input value="${this.attr(s.payment||'')}" onchange="Comparator.updateSupplier('${s.id}','payment',this.value)"></div>
          <div class="col-3 mhalf"><label>Total informado na cotação</label><input value="${this.attr(s.documentTotal||0)}" inputmode="decimal" onchange="Comparator.updateSupplier('${s.id}','documentTotal',this.value)"></div>
          <div class="col-3 mhalf"><label>Frete/ST informado</label><input value="${this.attr(s.documentExtra||0)}" inputmode="decimal" onchange="Comparator.updateSupplier('${s.id}','documentExtra',this.value)"></div>
          <div class="col-6"><label>Observação da leitura</label><input value="${this.attr(s.sourceNote||'')}" onchange="Comparator.updateSupplier('${s.id}','sourceNote',this.value)"></div>
          <div class="col-12"><label>Resposta em texto</label><textarea id="supplierText_${s.id}" class="compare-source" onchange="Comparator.updateSupplier('${s.id}','sourceText',this.value)" placeholder="Cole aqui exatamente a resposta recebida do fornecedor.">${this.esc(s.sourceText||'')}</textarea></div>
        </div>
        <div class="compare-toolbar">
          <button class="btn main" onclick="Comparator.processSupplierText('${s.id}')"><i class="fa-solid fa-wand-magic-sparkles"></i> Interpretar texto</button>
          <label class="btn line" for="supplierImage_${s.id}"><i class="fa-solid fa-camera"></i> Ler foto/tabela</label>
          <input id="supplierImage_${s.id}" class="hidden" type="file" accept="image/*" onchange="Comparator.processSupplierImage('${s.id}',this)">
        </div>
        <img id="supplierPreview_${s.id}" class="compare-image-preview" alt="Prévia da cotação">
        <div id="supplierBusy_${s.id}" class="compare-progress ${this.busySuppliers.has(s.id)?'show':''}"><span class="compare-spinner"></span><span id="supplierBusyText_${s.id}">Processando...</span></div>
        <div class="compare-divider"></div>
        <div id="supplierOffers_${s.id}">${this.renderOffers(s)}</div>
      </div>`).join('');
    },
    renderOffers(s){
      if(!s.offers.length)return '<div class="compare-empty">Nenhum item extraído deste fornecedor.</div>';
      return s.offers.map((o,oi)=>`<div class="compare-offer-card ${this.state.forcedOffers[o.requestedId]===o.id?'compare-selection':''}">
        <div class="compare-offer-head"><div><b>Oferta ${oi+1}</b> ${this.matchBadge(o)} ${o.priceBasis==='ambiguous'?'<span class="compare-badge warn">preço ambíguo</span>':''}</div><button class="btn bad small" onclick="Comparator.removeOffer('${s.id}','${o.id}')"><i class="fa-solid fa-trash"></i></button></div>
        <div class="compare-offer-grid">
          <div class="col-5"><label>Descrição do fornecedor</label><input value="${this.attr(o.description)}" onchange="Comparator.updateOffer('${s.id}','${o.id}','description',this.value)"></div>
          <div class="col-2 mhalf"><label>Marca</label><input value="${this.attr(o.brand)}" onchange="Comparator.updateOffer('${s.id}','${o.id}','brand',this.value)"></div>
          <div class="col-2 mhalf"><label>Código</label><input value="${this.attr(o.code)}" onchange="Comparator.updateOffer('${s.id}','${o.id}','code',this.value)"></div>
          <div class="col-3"><label>Vincular ao solicitado</label><select onchange="Comparator.updateOffer('${s.id}','${o.id}','requestedId',this.value)">${this.requestOptions(o.requestedId)}</select></div>
          <div class="col-2 mhalf"><label>Qtd. ofertada</label><input value="${this.attr(o.qtyOffered||0)}" inputmode="decimal" onchange="Comparator.updateOffer('${s.id}','${o.id}','qtyOffered',this.value)"></div>
          <div class="col-2 mhalf"><label>Preço unit.</label><input value="${this.attr(o.unitPrice||0)}" inputmode="decimal" onchange="Comparator.updateOffer('${s.id}','${o.id}','unitPrice',this.value)"></div>
          <div class="col-2 mhalf"><label>Total da linha</label><input value="${this.attr(o.lineTotal||0)}" inputmode="decimal" onchange="Comparator.updateOffer('${s.id}','${o.id}','lineTotal',this.value)"></div>
          <div class="col-2 mhalf"><label>Frete/ST linha</label><input value="${this.attr(o.lineExtra||0)}" inputmode="decimal" onchange="Comparator.updateOffer('${s.id}','${o.id}','lineExtra',this.value)"></div>
          <div class="col-2"><label>Base do preço</label><select onchange="Comparator.updateOffer('${s.id}','${o.id}','priceBasis',this.value)">${this.basisOptions(o.priceBasis)}</select></div>
          <div class="col-2"><label>Disponibilidade</label><select onchange="Comparator.updateOffer('${s.id}','${o.id}','availability',this.value)">${this.availabilityOptions(o.availability)}</select></div>
          <div class="col-12"><label>Observação</label><input value="${this.attr(o.notes||'')}" onchange="Comparator.updateOffer('${s.id}','${o.id}','notes',this.value)"></div>
        </div>
        <div class="compare-inline-note">Custo comparável por unidade: <b>${this.pricePerUnit(o)>0?this.money(this.pricePerUnit(o)):'não calculado'}</b>${o.rawLine?` · Linha original: ${this.esc(o.rawLine)}`:''}</div>
      </div>`).join('');
    },

    renderResults(){
      const box=this.$('compareResults');if(!box)return;
      const result=this.computeResult();this.state.lastResult=result;
      const active=this.activePlan(result);
      const unresolved=result.unresolved.length;
      const review=result.reviewOffers.length;
      const duplicateCount=this.state.requested.filter(r=>r.possibleDuplicate).length;
      const bestTotal=result.best?this.money(result.best.total):'—';
      const singleTotal=result.bestSingle?this.money(result.bestSingle.total):'—';
      const savings=result.savings>0?this.money(result.savings):'—';
      let warnings='';
      if(duplicateCount)warnings+=`<div class="compare-warning"><b>${duplicateCount} item(ns) possivelmente duplicado(s).</b> O sistema não apagou nem somou automaticamente. Confirme antes da compra.</div>`;
      if(unresolved)warnings+=`<div class="compare-error"><b>${unresolved} item(ns) sem oferta comparável:</b> ${result.unresolved.map(r=>this.esc(r.description)).join('; ')}.</div>`;
      if(review)warnings+=`<div class="compare-warning"><b>${review} oferta(s) exigem revisão.</b> Vínculo duvidoso, preço ambíguo ou item não identificado não entra automaticamente no plano.</div>`;
      if(result.best)warnings+=`<div class="compare-success"><b>Plano completo encontrado.</b> O cálculo considera quantidade disponível, custo por unidade, frete/ST da linha e frete fixo uma única vez por fornecedor usado.</div>`;
      box.innerHTML=`
        <div class="compare-kpis">
          <div class="compare-kpi good"><span>Melhor compra completa</span><b>${bestTotal}</b></div>
          <div class="compare-kpi"><span>Melhor fornecedor único</span><b>${singleTotal}</b></div>
          <div class="compare-kpi"><span>Economia ao combinar</span><b>${savings}</b></div>
          <div class="compare-kpi ${unresolved?'warn':''}"><span>Pendências</span><b>${unresolved+review}</b></div>
        </div>
        ${warnings}
        <div class="compare-tabs">
          <button class="compare-tab ${this.state.activeResultTab==='plans'?'active':''}" onclick="Comparator.setResultTab('plans')">Planos de compra</button>
          <button class="compare-tab ${this.state.activeResultTab==='matrix'?'active':''}" onclick="Comparator.setResultTab('matrix')">Matriz item × fornecedor</button>
        </div>
        <div class="${this.state.activeResultTab==='plans'?'':'compare-hidden'}">${this.renderPlans(result,active)}</div>
        <div class="${this.state.activeResultTab==='matrix'?'':'compare-hidden'}">${this.renderMatrix(result)}</div>
        <div class="compare-fixed-actions no-print">
          <div class="compare-toolbar">
            <button class="btn main" ${active?'':'disabled'} onclick="Comparator.copyPlanSummary()"><i class="fa-solid fa-copy"></i> Copiar resumo</button>
            <button class="btn line" ${active?'':'disabled'} onclick="Comparator.openPlanWhatsApp()"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>
            <button class="btn line" ${active?'':'disabled'} onclick="Comparator.generatePDF()"><i class="fa-solid fa-file-pdf"></i> PDF da comparação</button>
            <button class="btn ok" ${active?'':'disabled'} onclick="Comparator.sendPlanToBudget()"><i class="fa-solid fa-arrow-right"></i> Levar para orçamento</button>
          </div>
        </div>`;
    },
    setResultTab(tab){this.state.activeResultTab=tab;this.renderResults();this.save();},
    renderPlans(result,active){
      if(!this.state.requested.length)return '<div class="compare-empty">Primeiro interprete a lista solicitada.</div>';
      if(!result.best&&!result.bestSingle)return '<div class="compare-empty">Ainda não existe um plano completo. Corrija vínculos, preços ambíguos e itens ausentes.</div>';
      const plans=[];
      if(result.best)plans.push({...result.best,key:'best',label:result.best.label});
      if(result.bestSingle&&(!result.best||result.bestSingle.usedSupplierIds.join(',')!==result.best.usedSupplierIds.join(',')||Math.abs(result.bestSingle.total-result.best.total)>0.001))plans.push({...result.bestSingle,key:'single',label:'Melhor fornecedor único'});
      result.singles.slice(1,4).forEach(p=>plans.push(p));
      return plans.map((p,index)=>this.renderPlanCard(p,active?.key===p.key||this.state.selectedPlanKey===p.key,index===0)).join('');
    },
    renderPlanCard(plan,selected,isBest){
      const groups={};plan.allocations.forEach(a=>(groups[a.supplierId]||(groups[a.supplierId]=[])).push(a));
      const groupHtml=Object.entries(groups).map(([sid,items])=>{
        const s=this.supplier(sid),subtotal=items.reduce((sum,x)=>sum+x.total,0),freight=this.num(s?.freight);
        return `<div class="compare-plan-group"><h4>${this.esc(s?.name||'Fornecedor')} — ${this.money(subtotal+freight)}</h4>
          ${items.map(a=>`<div class="compare-plan-line"><span>${this.esc(a.qty)} × ${this.esc(a.description)}${a.brand?` <small>(${this.esc(a.brand)})</small>`:''}</span><strong>${this.money(a.total)}</strong></div>`).join('')}
          ${freight?`<div class="compare-plan-line"><span>Frete fixo</span><strong>${this.money(freight)}</strong></div>`:''}
        </div>`;
      }).join('');
      return `<div class="compare-plan-card ${isBest?'best':''} ${selected?'compare-selection':''}">
        <div class="compare-plan-head"><div><b>${this.esc(plan.label)}</b> ${isBest?'<span class="compare-badge ok">recomendado pelo menor custo completo</span>':''}</div><button class="btn ${selected?'main':'line'} small" onclick="Comparator.selectPlan('${plan.key}')"><i class="fa-solid fa-check"></i> ${selected?'Selecionado':'Selecionar'}</button></div>
        <div class="compare-kpis"><div class="compare-kpi"><span>Peças</span><b>${this.money(plan.itemsTotal)}</b></div><div class="compare-kpi"><span>Fretes fixos</span><b>${this.money(plan.freight)}</b></div><div class="compare-kpi"><span>Fornecedores</span><b>${plan.usedSupplierIds.length}</b></div><div class="compare-kpi good"><span>Total</span><b>${this.money(plan.total)}</b></div></div>
        <div class="compare-plan-groups">${groupHtml}</div>
      </div>`;
    },
    renderMatrix(result){
      if(!this.state.requested.length||!this.state.suppliers.length)return '<div class="compare-empty">A matriz aparece depois que houver itens e fornecedores.</div>';
      const headers=this.state.suppliers.map(s=>`<th>${this.esc(s.name)}</th>`).join('');
      const rows=this.state.requested.map((r,ri)=>{
        const candidates=result.candidates[r.id]||[],best=candidates[0]?.offer?.id;
        const cells=this.state.suppliers.map(s=>{
          const linked=s.offers.filter(o=>o.requestedId===r.id);
          if(!linked.length)return '<td><span class="compare-muted">Sem item vinculado</span></td>';
          const minis=linked.map(o=>{
            const valid=this.eligibleOffer(s,o,r),cost=this.pricePerUnit(o),isBest=o.id===best,forced=this.state.forcedOffers[r.id]===o.id;
            return `<div class="compare-offer-mini ${forced?'compare-selection':''}">
              <b>${this.esc(o.description)}</b>${o.brand?`<small>Marca: ${this.esc(o.brand)}</small>`:''}
              <small>Qtd.: ${this.esc(o.qtyOffered||'não informada')} · ${o.availability}</small>
              <span class="compare-price">${cost>0?this.money(cost)+'/un.':'não calculado'}</span>
              ${valid?`<button class="btn ${forced?'main':'line'} small" onclick="Comparator.forceOffer('${r.id}','${o.id}')">${forced?'Preferência fixada':isBest?'Usar/preferir':'Preferir esta'}</button>`:`<span class="compare-badge warn">não entra no cálculo</span>`}
            </div>`;
          }).join('');
          return `<td class="${linked.some(o=>o.id===best)?'compare-cell-best':linked.some(o=>o.matchStatus==='review')?'compare-cell-review':''}">${minis}</td>`;
        }).join('');
        return `<tr><td><b>${ri+1}. ${this.esc(r.description)}</b><br><span class="compare-muted">Quantidade necessária: ${this.esc(r.qty)}</span>${this.state.forcedOffers[r.id]?'<br><button class="btn line small" style="margin-top:6px" onclick="Comparator.forceOffer(\''+r.id+'\',\''+this.state.forcedOffers[r.id]+'\')">Voltar ao automático</button>':''}</td>${cells}</tr>`;
      }).join('');
      return `<div class="compare-table-wrap"><table class="compare-table"><thead><tr><th>Item solicitado</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },

    planSummary(plan){
      if(!plan)return '';
      const groups={};plan.allocations.forEach(a=>(groups[a.supplierId]||(groups[a.supplierId]=[])).push(a));
      const lines=[`COMPARAÇÃO DE PREÇOS${this.state.vehicle?` — ${this.state.vehicle}`:''}`,`Plano: ${plan.label}`,''];
      Object.entries(groups).forEach(([sid,items])=>{
        const s=this.supplier(sid);lines.push(`FORNECEDOR: ${s?.name||'-'}`);
        items.forEach(a=>lines.push(`- ${a.qty} x ${a.description}${a.brand?` — ${a.brand}`:''}: ${this.money(a.unitCost)} un. | ${this.money(a.total)}`));
        if(this.num(s?.freight))lines.push(`- Frete fixo: ${this.money(s.freight)}`);
        lines.push('');
      });
      lines.push(`TOTAL DAS PEÇAS: ${this.money(plan.itemsTotal)}`);lines.push(`FRETES FIXOS: ${this.money(plan.freight)}`);lines.push(`TOTAL DA COMPRA: ${this.money(plan.total)}`);
      return lines.join('\n');
    },
    async copyText(text){
      try{await navigator.clipboard.writeText(text);return true;}catch(e){
        const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();return ok;
      }
    },
    async copyPlanSummary(){const p=this.activePlan(this.state.lastResult||this.computeResult());if(!p)return;await this.copyText(this.planSummary(p));this.toast('Resumo da compra copiado.');},
    openPlanWhatsApp(){const p=this.activePlan(this.state.lastResult||this.computeResult());if(!p)return;window.open('https://wa.me/?text='+encodeURIComponent(this.planSummary(p)),'_blank');},
    sendPlanToBudget(){
      const p=this.activePlan(this.state.lastResult||this.computeResult());if(!p||!window.App)return;
      const raw=prompt('Percentual de acréscimo sobre o custo para levar ao orçamento. Digite 0 para copiar o custo sem acréscimo.','0');if(raw===null)return;
      const markup=Math.max(0,this.num(raw));
      if(!confirm(`Adicionar ${p.allocations.length} linha(s) ao orçamento atual com acréscimo de ${markup}%? As peças já existentes não serão apagadas.`))return;
      p.allocations.forEach(a=>{
        App.addPart({description:a.description,descricao:a.description,qtd:a.qty,valorUnit:a.unitCost*(1+markup/100),fornecedor:[a.brand,a.supplierName].filter(Boolean).join(' | '),cod:a.code||'',desc:0});
      });
      App.saveLocal(false);App.show('secItens');this.toast('Itens escolhidos adicionados ao orçamento sem apagar os anteriores.');
    },
    generatePDF(){
      const p=this.activePlan(this.state.lastResult||this.computeResult());if(!p)return;
      if(!window.jspdf?.jsPDF){this.toast('Biblioteca de PDF não carregada.');return;}
      const {jsPDF}=window.jspdf,doc=new jsPDF({unit:'mm',format:'a4'});
      doc.setFont('helvetica','bold');doc.setFontSize(15);doc.text('COMPARAÇÃO INTELIGENTE DE PREÇOS',14,16);
      doc.setFont('helvetica','normal');doc.setFontSize(9);doc.text(`Veículo: ${this.state.vehicle||'-'}`,14,23);doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`,14,28);
      const rows=p.allocations.map(a=>[a.description,a.brand||'-',a.supplierName,String(a.qty),this.money(a.unitCost),this.money(a.total)]);
      doc.autoTable({startY:34,head:[['Item','Marca','Fornecedor','Qtd.','Unitário','Total']],body:rows,styles:{fontSize:7,cellPadding:2},headStyles:{fillColor:[17,24,39]},columnStyles:{0:{cellWidth:58},1:{cellWidth:24},2:{cellWidth:35},3:{cellWidth:13},4:{cellWidth:24},5:{cellWidth:24}}});
      let y=doc.lastAutoTable.finalY+8;doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text(`Peças: ${this.money(p.itemsTotal)}`,196,y,{align:'right'});doc.text(`Fretes fixos: ${this.money(p.freight)}`,196,y+6,{align:'right'});doc.setFontSize(12);doc.text(`TOTAL: ${this.money(p.total)}`,196,y+13,{align:'right'});
      doc.setFontSize(7);doc.setTextColor(100);doc.text('Powered by thIAguinho Soluções Digitais',105,290,{align:'center'});
      const name='Comparacao_'+(this.state.vehicle||'pecas').replace(/[^A-Za-z0-9]+/g,'_')+'.pdf';doc.save(name);this.toast('PDF da comparação gerado.');
    },

    exportJSON(){
      const blob=new Blob([JSON.stringify({...this.state,lastResult:null},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='comparacao_'+(this.state.vehicle||'pecas').replace(/[^A-Za-z0-9]+/g,'_')+'.json';a.click();URL.revokeObjectURL(a.href);
    },
    importJSON(input){
      const file=input?.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{try{const data=JSON.parse(reader.result);this.state=Object.assign(this.defaultState(),data);this.$('compareVehicle').value=this.state.vehicle||'';this.$('compareRequestText').value=this.state.requestText||'';this.renderAll();this.toast('Comparação importada.');}catch(e){this.toast('Arquivo de comparação inválido.');}input.value='';};reader.readAsText(file);
    },
    clearAll(){if(!confirm('Apagar toda a comparação salva? O orçamento principal não será alterado.'))return;this.state=this.defaultState();localStorage.removeItem(this.STORAGE_KEY);this.$('compareVehicle').value='';this.$('compareRequestText').value='';this.renderAll();this.toast('Comparação limpa.');},
    setGlobalBusy(on,text='Processando...'){const el=this.$('compareGlobalBusy');if(!el)return;el.classList.toggle('show',!!on);const t=this.$('compareGlobalBusyText');if(t)t.textContent=text;},
    setSupplierBusy(id,on,text='Processando...'){if(on)this.busySuppliers.add(id);else this.busySuppliers.delete(id);const el=this.$(`supplierBusy_${id}`);if(el)el.classList.toggle('show',!!on);const t=this.$(`supplierBusyText_${id}`);if(t)t.textContent=text;},

    loadExample(){
      if((this.state.requested.length||this.state.suppliers.length)&&!confirm('Substituir a comparação atual pelo exemplo real enviado do Uno?'))return;
      const req=(description,qty,notes='')=>({id:this.id('req'),description,qty,unit:'PC',notes,possibleDuplicate:false});
      const requested=[
        req('EMBREAGEM',1),req('CABO DE EMBREAGEM',1),req('AMORTECEDOR DIANTEIRO',2),req('KIT',2,'Linha original após amortecedores dianteiros; confirmar aplicação'),
        req('PIVÔ DA BARRA DE TORÇÃO / TIPO MORCEGUINHO',2,'Terminologia precisa ser confirmada; não confundir com bucha ou terminal'),req('BRAÇO OSCILANTE',2),req('PNEUZINHO / BUCHA DA BARRA',4),
        req('RETENTOR DO MANCAL',1),req('COIFA EXTERNA',2),req('COIFA INTERNA',2),req('BUCHA BANDEJA TRASEIRA',8),req('AMORTECEDOR TRASEIRO',2),
        req('KIT',2,'Linha original após amortecedores traseiros; confirmar aplicação'),req('RETENTOR DO MANCAL',1,'Possível repetição da linha anterior de retentor; confirmar')
      ].map((x,i)=>({...x,order:i}));
      const makeSupplier=(name,sourceText='')=>({id:this.id('sup'),name,phone:'',freight:0,payment:'',documentTotal:0,documentExtra:0,sourceText,sourceNote:'Dados do exemplo enviado; conferir antes de comprar.',imageName:'',offers:[]});
      const add=(s,raw)=>s.offers.push(this.normalizeOffer({...raw,order:s.offers.length},s));
      const s1=makeSupplier('FORNECEDOR TEXTO 1',`Uno 1.0 Way 2010 - Quadrado\n- embreagem 297.70 luk\n- cabo de embreagem 40.50\n- 2 amortecedores dianteiros 201.50 cada Monroe\n- 2 kit 49.80 axios\n- 2 pivos 43.20 nakata\n- 2 braços oscilantes 83.50 nakata\n- 4 pneuzinhos 12.25 cada axios\n- 1 retentor do mancal 133.50 sabo\n- 2 coifas externas 17.25 sabo\n- 2 coifas internas 13.50 spicer\n- 8 buchas bandeja traseiras 9.80 só tem 4\n- 2 amortecedores traseiros 181.50 cada nakata\n- 2 kits não vai`);
      [
        ['EMBREAGEM','LUK',1,297.70,'unit','available'],['CABO DE EMBREAGEM','',1,40.50,'unit','available'],['AMORTECEDOR DIANTEIRO','MONROE',2,201.50,'unit','available'],
        ['KIT','AXIOS',2,0,'ambiguous','available',49.80],['PIVÔ DA BARRA / MORCEGUINHO','NAKATA',2,0,'ambiguous','available',43.20],['BRAÇO OSCILANTE','NAKATA',2,0,'ambiguous','available',83.50],
        ['PNEUZINHO / BUCHA BARRA','AXIOS',4,12.25,'unit','available'],['RETENTOR DO MANCAL','SABO',1,133.50,'unit','available'],['COIFA EXTERNA','SABO',2,0,'ambiguous','available',17.25],
        ['COIFA INTERNA','SPICER',2,0,'ambiguous','available',13.50],['BUCHA BANDEJA TRASEIRA','',4,9.80,'unit','partial'],['AMORTECEDOR TRASEIRO','NAKATA',2,181.50,'unit','available'],['KIT','',0,0,'unit','unavailable']
      ].forEach(v=>add(s1,{description:v[0],brand:v[1],qtyOffered:v[2],unitPrice:v[3],priceBasis:v[4],availability:v[5],lineTotal:v[6]||0,notes:v[4]==='ambiguous'?'Confirmar se o valor é unitário ou total.':''}));
      const s2=makeSupplier('AUTO CENTER — FOTO 1');s2.documentTotal=1711.30;
      [
        ['KIT EMBREAGEM C/ROL 180MM 20 ESTRIAS','LUK','618301700',1,303.80],['RETENTOR VIRABREQUIM TRASEIRO FLANGE','SABO','05245MJEF',1,158.20],['COIFA HOMOCINÉTICA INTERNA','SPICER','213659G',2,17.00],
        ['BUCHA BARRA ESTABILIZADORA DIANTEIRA','MOBENSANI','MB416',4,6.30],['KIT BATENTE AMORTECEDOR DIANTEIRO COMPLETO 1 LADO','MOBENSANI','MB4073B',2,37.00],['AMORTECEDOR DIANTEIRO SUPER','MONROE','334295MM',2,194.30],
        ['CABO EMBREAGEM 705 MM','EFFARI','FNM088H',1,44.70],['BUCHA BANDEJA TRASEIRA','MOBENSANI','MB413',8,10.00],['BRAÇO OSCILANTE PIVÔ','PERFECT','BRA3029',2,71.40],
        ['AMORTECEDOR TRASEIRO ÓLEO','MONROE','749175SP',2,211.20],['COIFA HOMOCINÉTICA EXTERNA COIFA DE BORRACHA','COFAP','KJH03213',2,18.80]
      ].forEach(v=>add(s2,{description:v[0],brand:v[1],code:v[2],qtyOffered:v[3],unitPrice:v[4],priceBasis:'unit',availability:'available'}));
      const s3=makeSupplier('C2 / FUPLAN — FOTO 2');s3.documentTotal=2286.70;s3.documentExtra=10.00;
      [
        ['KIT EMBREAGEM C/ROL 180MM 20 ESTRIAS','LUK','618301700',1,322.10,1.40],['RETENTOR VIRABREQUIM TRASEIRO','SABO','05245MJEF',1,158.20,.60],['COIFA HOMOCINÉTICA INTERNA C/2 ABRAÇADEIRAS','SPICER','213659G',2,21.00,.10],
        ['KIT ESTABILIZADOR DIANTEIRO INTERNO','BROKITS','44004',2,7.00,0],['KIT ESTABILIZADOR DIANTEIRO EXTERNO','BROKITS','44007',2,13.30,.10],['BUCHA BANDEJA TRASEIRA','AXIOS','0120399',8,15.80,.50],
        ['BUCHA BARRA ESTABILIZADORA DIANTEIRA','AXIOS','011048',4,15.00,.20],['COIFA HOMOCINÉTICA EXTERNA','SPICER','213599GN',2,30.40,.20],['CABO EMBREAGEM','FANIA','81131',1,70.60,.30],
        ['COXIM SUPERIOR AMORTECEDOR TRASEIRO','AXIOS','0210602',2,49.40,.40],['AMORTECEDOR DIANTEIRO SUPER','MONROE','334295MM',2,212.00,1.80],['KIT BATENTE AMORTECEDOR DIANTEIRO','AXIOS','0441490',2,62.00,.50],
        ['TERMINAL BARRA ESTABILIZADORA','COFAP','TDC03003M',2,71.20,.60],['BRAÇO OSCILANTE PIVÔ','PERFECT','BRA3029',2,85.00,.70],['AMORTECEDOR TRASEIRO ÓLEO','MONROE','749175SP',2,218.40,2.60]
      ].forEach(v=>add(s3,{description:v[0],brand:v[1],code:v[2],qtyOffered:v[3],unitPrice:v[4],lineExtra:v[5],priceBasis:'unit',availability:'available'}));
      const s4=makeSupplier('FORNECEDOR TEXTO 2');
      [
        ['EMBREAGEM','LUK',1,299.46],['EMBREAGEM','VALEO',1,284.00],['CABO EMBREAGEM','FANIA',1,47.68],['AMORTECEDOR DIANTEIRO','COFAP',2,238.04],['KIT DIANTEIRO','AXIOS',2,50.72],
        ['PIVÔ','VIEMAR',2,32.40],['BRAÇO OSCILANTE','NAKATA',2,88.52],['BUCHA PNEUZINHO','AXIOS',4,12.00],['RETENTOR MANCAL','CORTECO',1,84.04],['RETENTOR MANCAL','SABO',1,136.70],
        ['COIFA RODA','SPICER',2,21.32],['COIFA CÂMBIO','SPICER',2,15.57],['BUCHA BANDEJA','AXIOS',8,13.52],['AMORTECEDOR TRASEIRO','COFAP',2,231.94]
      ].forEach(v=>add(s4,{description:v[0],brand:v[1],qtyOffered:v[2],unitPrice:v[3],priceBasis:'unit',availability:'available'}));
      this.state={...this.defaultState(),vehicle:'UNO 1.0 WAY 2010 — QUADRADO',requestText:'Lista real do exemplo enviado',requested,suppliers:[s1,s2,s3,s4],forcedOffers:{},selectedPlanKey:'best',activeResultTab:'plans'};
      this.$('compareVehicle').value=this.state.vehicle;this.$('compareRequestText').value=this.state.requestText;
      this.matchAll(true);this.renderAll();this.toast('Exemplo real carregado. Revise os avisos amarelos e o retentor repetido.');
    }
  };

  window.Comparator=Comparator;
  window.addEventListener('DOMContentLoaded',()=>Comparator.init());
})();
