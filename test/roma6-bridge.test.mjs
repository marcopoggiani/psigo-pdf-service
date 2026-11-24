import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
import {setTimeout as delay} from "node:timers/promises";

test("Roma6 bridge rejects unauthorized, unverified paths and pagination without upstream access", {timeout:15000}, async()=>{
  const socket=createServer();
  socket.listen(0,"127.0.0.1");
  await once(socket,"listening");
  const port=socket.address().port;
  await new Promise((resolve,reject)=>socket.close(err=>err?reject(err):resolve()));
  const secret="test-only-secret";
  const child=spawn(process.execPath,["server.js"],{env:{...process.env,PORT:String(port),PDF_SERVICE_SECRET:secret},stdio:["ignore","ignore","pipe"]});
  let stderr="";
  child.stderr.on("data",chunk=>{stderr+=String(chunk).slice(0,500);});
  const base="http://127.0.0.1:"+port;
  try{
    let ready=false;
    for(let i=0;i<40;i++){
      if(child.exitCode!==null)throw Error("server exited: "+stderr);
      try{const response=await fetch(base);if(response.ok){ready=true;break}}catch{}
      await delay(150);
    }
    assert.ok(ready,"test service starts");
    const post=(body,key=secret)=>fetch(base+"/lazio-hospital-html",{method:"POST",headers:{"Content-Type":"application/json","x-psigo-secret":key},body:JSON.stringify(body)});
    assert.equal((await post({source:"roma6",page:1},"bad")).status,401);
    for(const body of [{source:"roma6",page:2},{source:"roma6",detailPath:"/private"},{source:"roma6",detailPath:"//example.com"},{source:"roma6",page:1,url:"https://example.com"},{source:"unknown",page:1}]){
      const response=await post(body);
      assert.equal(response.status,400,JSON.stringify(body));
      assert.equal((await response.json()).ok,false);
    }
  }finally{child.kill();if(child.exitCode===null)await once(child,"exit");}
});
