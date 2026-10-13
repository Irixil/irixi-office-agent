// Host-only contract diagnosis and validator checks. Never authors business code.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
export async function runResponseContractChecks({root,workspace,evidenceFile,responseContracts}){
  const coreBytes=await fs.readFile(path.join(workspace,'core.js'));
  const appBytes=await fs.readFile(path.join(workspace,'app.js'));
  const context=vm.createContext({});vm.runInContext(coreBytes.toString(),context);
  const parse=(data,kind,options)=>context.LearningCore.parseModelText(JSON.stringify(data),kind,options);
  const oldDir=path.join(root,'backend/actual-native-learning-acceptance-20261005');
  const actual=JSON.parse(await fs.readFile(path.join(oldDir,'recover-original-e34daf48-fe89-45ee-8aa7-bacf54fda6d0/native-http-result-4.json'))).result;
  const article=await fs.readFile(path.join(root,'materials/synthetic-correlation-article.txt'),'utf8');
  const old=JSON.parse(actual.text),types=['cause','misconception','application','transfer'];
  const explanation=structuredClone(old);explanation.coverage.forEach(c=>{c.questionTypes=Object.keys(c.questionTypes);});
  const concept=explanation.concepts[0];
  const wrong='两个现象同时上升就证明一个导致另一个。';
  const assessment={verdict:'incorrect',correct:[],errors:[{conceptId:concept.id,claim:wrong,why:'共同变化不能排除其他共同原因',location:concept.location}],omissions:[],evidence:[{conceptId:concept.id,location:concept.location,quote:concept.sourceQuote,reason:'原文区分相关与因果，作答没有保留这一限制'}],remediation:{explanation:'一起变化还可能由共同因素造成。',example:'天气炎热可能同时影响冰淇淋销量与游泳人数。'},retest:{question:'一个社区健身房客流与运动饮料销量同步增加，能否据此确定因果？',unseenWhy:'换成原文没有出现的场景'},conceptResults:[{id:concept.id,label:concept.title,status:'weak',evidenceIndexes:[0],deficiency:{type:'error',index:0}}]};
  const options={articleText:article,concepts:explanation.concepts,learnerResponse:wrong};
  const summary={known:[],weak:[concept.title],untested:explanation.concepts.slice(1).map(c=>c.title),nextPractice:['独立解释相关与因果的区别'],userOpinions:['我的判断与作答证据分别记录']};
  const report={at:new Date().toISOString(),evidenceType:'controlled typed fixtures plus preserved actual learning01 response; original native validator',passed:false,nativeModelCalls:0,businessFilesChangedByRoot:false,actualBrowser:false,coreSha256:hash(coreBytes),appSha256:hash(appBytes),actualResponseSha256:actual.textSha256,cases:[],responseContracts};
  const record=(name,fn)=>{fn();report.cases.push({name,passed:true});};
  const refuses=(name,data,kind,opts)=>record(name,()=>assert.throws(()=>parse(data,kind,opts)));
  const mutation=(sample,fn)=>{const d=structuredClone(sample);fn(d);return d;};
  try{
    assert.equal(hash(coreBytes),'4936f6700b5d85829302de39bb841a3f01e079dc7444724b0282d6f156eca438','Judgment validator must remain unchanged');
    refuses('Preserved real object questionTypes is still rejected; no old output accepted',old,'explain',{articleText:article});
    record('Typed explanation with original quotes/relations and all existing coverage types passes',()=>parse(explanation,'explain',{articleText:article}));
    record('Typed wrong retell with source-bound error and weak deficiency passes',()=>parse(assessment,'assess',options));
    const corrected=mutation(assessment,d=>{d.verdict='correct';d.correct=['只观察到相关，不能确定因果'];d.errors=[];d.conceptResults[0].status='verified';d.conceptResults[0].deficiency=null;});
    record('Typed correct retell permits null non-weak deficiency without changing judgment',()=>parse(corrected,'assess',{...options,learnerResponse:'一起上升只是相关；天气炎热可能影响两者，需要对照证据。'}));
    record('All summary fields accept string arrays',()=>parse(summary,'summarize',{}));
    refuses('Non-string explanation scalar',mutation(explanation,d=>d.concepts[0].title=42),'explain',{articleText:article});
    refuses('Missing coverage type',mutation(explanation,d=>d.coverage[0].questionTypes=['cause']),'explain',{articleText:article});
    refuses('Unknown relation concept',mutation(explanation,d=>d.concepts[0].relations=[{to:'unknown',type:'关系',explanation:'解释'}]),'explain',{articleText:article});
    refuses('Invented source quote',mutation(explanation,d=>d.concepts[0].sourceQuote='原文未出现的引文'),'explain',{articleText:article});
    refuses('Invalid verdict enum',mutation(assessment,d=>d.verdict='mastered'),'assess',options);
    refuses('Correct is not string array',mutation(assessment,d=>d.correct='正确'),'assess',options);
    refuses('Error claim is not string',mutation(assessment,d=>d.errors[0].claim={text:wrong}),'assess',options);
    refuses('Legacy string omissions',mutation(assessment,d=>d.omissions=['遗漏']),'assess',options);
    refuses('Evidence reason is not string',mutation(assessment,d=>d.evidence[0].reason=[]),'assess',options);
    refuses('Remediation is not string-valued object',mutation(assessment,d=>d.remediation.explanation=[]),'assess',options);
    refuses('Retest unseenWhy is not string',mutation(assessment,d=>d.retest.unseenWhy=true),'assess',options);
    refuses('Evidence indexes are not integers',mutation(assessment,d=>d.conceptResults[0].evidenceIndexes=['0']),'assess',options);
    refuses('Weak deficiency index is not integer',mutation(assessment,d=>d.conceptResults[0].deficiency.index='0'),'assess',options);
    refuses('Unsupported concept result state',mutation(assessment,d=>d.conceptResults[0].status='mastered'),'assess',options);
    refuses('Source evidence cannot switch concepts',mutation(assessment,d=>d.evidence[0].conceptId=explanation.concepts[1].id),'assess',options);
    refuses('Unevaluated cannot certify verified',mutation(corrected,d=>d.verdict='unevaluated'),'assess',options);
    for(const key of Object.keys(summary))refuses('Summary '+key+' remains string array',mutation(summary,d=>d[key]=[{text:'value'}]),'summarize',{});
    const contracts=responseContracts;assert.deepEqual(Object.keys(contracts).sort(),['assess','explain','summarize']);
    const coverage=contracts.explain.required.coverage;
    const literal=/questionTypes\s*:\s*(\[[^\]]+\])/.exec(coverage)?.[1];assert.ok(literal,'Model contract needs an exact questionTypes JSON array example');
    assert.deepEqual(JSON.parse(literal),types);
    const shared=kind=>/all\s+(?:named\s+)?(?:scalar\s+)?fields[^.\n]{0,100}strings?|(?:named|scalar)\s+fields[^.\n]{0,100}strings?/i.test(contracts[kind].purpose||'');
    for(const [kind,fields] of Object.entries({explain:['concepts'],assess:['errors','omissions','evidence','remediation','retest']})){
      for(const field of fields)assert.ok(shared(kind)||/strings?/i.test(contracts[kind].required[field]),kind+'.'+field+' must state scalar string types explicitly');
    }
    assert.ok(/index\W{0,4}(?:is\s+)?integer/i.test(contracts.assess.required.conceptResults),'deficiency.index integer type must be explicit');
    record('Actual model-facing three contracts explicitly declare existing types',()=>{});
    report.passed=true;
  }catch(error){report.error=error.message;}
  report.sourceUnchanged=hash(await fs.readFile(path.join(workspace,'app.js')))===report.appSha256&&hash(await fs.readFile(path.join(workspace,'core.js')))===report.coreSha256;
  if(!report.sourceUnchanged){report.passed=false;report.error='Source changed during host checks';}
  await fs.writeFile(evidenceFile,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return report;
}
