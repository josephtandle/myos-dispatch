import http from 'node:http';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import access from '../../src/atelier-access.js';
import {createTokenVerifier} from './auth.mjs';

export const taskClass='data_lookup';
const schema=z.object({projectId:z.string().min(1).max(120),brandId:z.string().min(1).max(120).optional(),query:z.string().max(2000).default('')}).strict();
const send=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
async function readBody(req) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw new Error('body_too_large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createAccessServer(config,{key,audit=()=>{}}={}) {
  if(config.enabled!==true)throw new Error('access_disabled');
  const verify=createTokenVerifier(config,{key});
  const resource=new URL(config.resource);
  if(resource.pathname!=='/mcp')throw new Error('resource_endpoint_mismatch');
  const metadataPath='/.well-known/oauth-protected-resource'+(resource.pathname==='/'?'':resource.pathname);
  const metadataUrl=resource.origin+metadataPath;
  const challenge=`Bearer resource_metadata="${metadataUrl}", scope="atelier:read"`;
  let active=0;
  const server=http.createServer({maxHeaderSize:20000,requestTimeout:10000,headersTimeout:10000},async(req,res)=>{
    const localHost='127.0.0.1:'+server.address().port;
    if(![localHost,resource.host].includes(req.headers.host)||req.headers.origin&&req.headers.origin!==resource.origin){send(res,403,{error:'forbidden_origin'});return;}
    if(active>=8){send(res,429,{error:'busy'});return;}
    active++;
    try {
      const route=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&route===metadataPath){
        send(res,200,{resource:config.resource,authorization_servers:[config.issuer],scopes_supported:['atelier:read'],bearer_methods_supported:['header']});return;
      }
      if(!['/mcp','/api/knowledge'].includes(route)){send(res,404,{error:'not_found'});return;}
      let principal;
      try{principal=await verify(req.headers.authorization);}catch{audit({taskClass,event:'authentication_denied'});send(res,401,{error:'authentication_required'},{'WWW-Authenticate':route==='/mcp'?challenge:'Bearer scope="atelier:read"'});return;}
      if(req.method!=='POST'){send(res,405,{error:'method_not_allowed'},{Allow:'POST'});return;}
      let body;
      try{body=await readBody(req);}catch{send(res,400,{error:'invalid_request'});return;}
      const query=input=>{
        const result=access.readAuthorizedKnowledge({registryPath:config.registryPath,policyPath:config.policyPath,principal,...schema.parse(input)});
        audit({taskClass,event:'knowledge_read',status:result.status});return result;
      };
      if(route==='/api/knowledge'){
        const parsed=schema.safeParse(body);if(!parsed.success){send(res,400,{error:'invalid_request'});return;}
        const result=query(parsed.data);send(res,result.status==='ok'?200:result.status==='denied'?403:503,result);return;
      }
      const mcp=new McpServer({name:'myos-atelier-access',version:'0.1.0'});
      mcp.registerTool('search_knowledge',{
        title:'Search permitted project knowledge',description:'Read current knowledge for one explicit project and optional brand. Does not change sources.',inputSchema:schema.shape,
        annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
        _meta:{securitySchemes:[{type:'oauth2',scopes:['atelier:read']}]}
      },async input=>{const result=query(input);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:result.status!=='ok'};});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.once('close',()=>{void transport.close();void mcp.close();});
      await mcp.connect(transport);
      await transport.handleRequest(req,res,body);
    } catch {if(!res.headersSent)send(res,500,{error:'internal_error'});}
    finally {active--;}
  });
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    const config=JSON.parse(fs.readFileSync(process.argv[2]||'access.config.json','utf8'));
    const server=createAccessServer(config,{audit:event=>console.log(JSON.stringify(event))});
    server.listen(config.port||8140,'127.0.0.1',()=>console.log(JSON.stringify({taskClass,status:'listening',host:'127.0.0.1',port:server.address().port})));
  } catch{console.error('Atelier access did not start. Supply a valid enabled owner-local configuration.');process.exitCode=1;}
}
