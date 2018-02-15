const 
    async = require('async'),
    request = require('request-promise-native'),
    DockerEvents = require('docker-events'),
    Dockerode = require('dockerode'),
    jsonQuery = require('json-query');

var emitter = new DockerEvents({
        docker: new Dockerode({socketPath: '/var/run/docker.sock'}),
    });

const _prefix = process.env.SVC_PREFIX || "";
const _consulAgent = process.env.CONSUL_ADDR || "http://localhost:8500";
const _consulToken = process.env.CONSUL_TOKEN || null;
const _baseTags = (process.env.SERVICE_TAGS || '')
    .split(',')
    .map(tag => (tag || '').trim())
    .filter(tag => tag.length > 0);
const _ignoreUnnamedServices = Boolean(process.env.SERVICE_IGNORE_NAMELESS)

var _hostUuid = null;

emitter.start();

emitter.on("connect", async function() {
    try {
        console.log("connected to docker api");
        console.log("register existing containers");

        let services = await getServices(),
            hostUuid = await getHostUUID();

        console.log('host uuid: ' + hostUuid);
        console.log("services for node: " + services.length);

        await deregisterServices(services.map(service => service.ID));

        getContainers('running')
            .then(registerContainers)
            .then(function (value) {
                console.log(value);
            }).catch(function(err){
                console.error("Startup; " + err);
            })
    }
    catch(err) {
        console.error('Startup; ' + err);

        process.exit(-1);
    }
});

function delay(ms) {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, Number(ms) || 1);
    })
}

emitter.on('start', async function(evt){
    try {
        var name = evt.Actor.Attributes['io.rancher.container.name'] || evt.Actor.Attributes.name;
        var uuid = evt.Actor.Attributes['io.rancher.container.uuid'];

        console.log(new Date() + ' - container start ' + name + ' (image : '+evt.Actor.Attributes.image+')');

        console.log('start: ' + JSON.stringify(evt));

        await delay(5000);

        var container = await getContainerById(uuid);

        tryRegisterContainer(container)
            .then(function (value) {
                if(value) console.log(value);
            }).catch(function(err){
                console.error("Registering; " + err);
            })
    }
    catch(err) {
        console.error('Registering; ' + err);
    }
});

emitter.on('destroy', async (evt) => {
    console.log('destroy: ' + JSON.stringify(evt));
});

emitter.on('restart', async (evt) => {
    console.log('restart: ' + JSON.stringify(evt));
});

emitter.on('pause', async (evt) => {
    console.log('pause: ' + JSON.stringify(evt));
})

emitter.on('unpause', async (evt) => {
    console.log('unpause: ' + JSON.stringify(evt));
})

emitter.on('health_status', async (evt) => {
    console.log('health: ' + JSON.stringify(evt));
})

emitter.on('stop', async function(evt){
    try {
        var name = evt.Actor.Attributes['io.rancher.container.name'] || evt.Actor.Attributes.name;
        var uuid = evt.Actor.Attributes['io.rancher.container.uuid'];
        console.log(new Date() + ' - container stop ' + name + ' (image : '+evt.Actor.Attributes.image+')');

        console.log('stop: ' + JSON.stringify(evt));

        let service = await getServiceByRancherId(uuid);
        if( service == null)
            return console.error(`Deregistrering; service with rancher id ${uuid} does not exist`);

        deregisterServices(service.ID)
            .then(function (value) {
                console.log(value);
            }).catch(function(err){
                console.error("Deregistrering; " + err);
            })
    }
    catch(err) {
        console.error('Deregistrering; ' + err);
    }
});

function registerContainers(input) {   
    return Promise.all(input.map(container => tryRegisterContainer(container)))
        .then(value => {
            return [].concat.apply([], value);
        });
}

function tryRegisterContainer(input){
    return new Promise(
        function(resolve, reject) {
            //console.log("tryRegisterContainer: " + input.servicename);

            resolve(input);
        })
        .then(getAgentIP)
        .then(checkForPortMapping)
        .then(checkForServiceIgnoreLabel)
        .then(checkForServiceNameLabel)
        .then(checkForServiceTagsLabel)
        .then(checkForHealthCheckLabel)
        .then(registerService)
        .catch(function(err){
            console.log(err);

            return [];
        })
}

async function getContainers(state) {
    let response = await request({
            method:"GET",
            url: "http://rancher-metadata/latest/containers/",
            headers:{
                "accept" : "application/json"
            },
            resolveWithFullResponse: true
        }),
        body = JSON.parse(response.body),
        hostUuid = await getHostUUID();

    if(Array.isArray(body)) {
        return body
            .filter(container => container.host_uuid == hostUuid)
            .filter(container => state == null || state == "" || container.state == state)
            .map(container => Object.assign({}, { 
                id: container.labels['io.rancher.container.uuid'],
                metadata: container, 
                servicename: container.labels['io.rancher.container.name'] 
            }));
    }

    return [];
}

async function getContainerById(id) {
    let containers = (await getContainers())
        .filter(container => container.id == id) 

    if(containers.length == 1)
        return containers[0];

    return null;        
}

async function getContainerByName(servicename) {
    let container = (await getContainers())
        .filter(container => new String(container.servicename).toLowerCase() == new String(servicename).toLowerCase())

    if(containers.length == 1)
        return containers[0];

    return null;        
}

function getMetaData(servicename){
    return getContainerByName(servicename);
}

async function getHostUUID() {
    if(_hostUuid)
        return _hostUuid;

    let response = await request({
            method: "GET",
            url: "http://rancher-metadata/latest/self/host",
            headers:{
                "accept" : "application/json"
            },
            resolveWithFullResponse: true
        }),
        body = JSON.parse(response.body);

    return _hostUuid = body.uuid;
}

function getAgentIP(input){
    return new Promise(
        function(resolve,reject){
            //console.log("getAgentIP: " + input.servicename);

            var query = {
                "method":"GET",
                "url": "http://rancher-metadata/latest/self/host",
                "headers":{
                    "accept" : "application/json"
                }
            }

            request(query,function (error, response, body) {
                if (error) {
                    reject("getAgentIP error : " + error);
                }

                input.metadata.hostIP = JSON.parse(body).agent_ip;
                resolve(input);
            })
        }
    )
}

function checkForPortMapping(input){
    return new Promise(
        function(resolve,reject){
            //console.log("checkForPortMapping: " + input.servicename);

            if(input.metadata.ports && input.metadata.ports.length > 0){
                input.metadata.portMapping = [];
                input.metadata.ports.forEach(function(pm){
                    var portMapping = pm.split(":");
                    var internal = portMapping[2].split("/");
                    var ip = input.metadata.hostIP;
                    input.metadata.portMapping.push({"address":ip,"publicPort":portMapping[1],"privatePort":internal[0],"transport":internal[1]});
                })
                resolve(input);
            }
            else
            {
                reject("No port mappings for " + input.servicename)
            }
        }
    )
}

function checkForServiceIgnoreLabel(input){
    return new Promise(
        function(resolve,reject){
            if(input.metadata.labels.SERVICE_IGNORE){
                console.log("Service_Ignore found");
                reject("Service ignored " + input.servicename);
            }
            else {
                resolve(input)
            }

        }
    )
}

function checkForServiceNameLabel(input){
    return new Promise(
        function(resolve,reject){
            if(input.metadata.labels.SERVICE_NAME){
                console.log("Service_Name found");
                input.metadata.service_name = input.metadata.labels.SERVICE_NAME;
            }
            resolve(input)
        }
    )
}

function checkForServiceTagsLabel(input){
    return new Promise(
        function(resolve,reject){
            if(input.metadata.labels.SERVICE_TAGS) {
                console.log("Service_Tags found");
                input.metadata.service_tags = (input.metadata.labels.SERVICE_TAGS || '')
                    .split(',')
                    .map(tag => (tag || "").trim())
                    .filter(tag => tag.length > 0);
            }
            port_names = {};
            for (var key in input.metadata.labels) {
                if (input.metadata.labels.hasOwnProperty(key)) {

                    //Check if SERVICE_XXX_NAME is there
                    var checkPattern = /SERVICE_(\d+)_NAME/g;
                    var checkMatch = checkPattern.exec(key);

                    //indice 1 of checkMatch contains the private port number
                    if(checkMatch){
                      port_names[checkMatch[1]] = input.metadata.labels[key]
                    }
                }
            }
            input.metadata.port_service_names = port_names
            resolve(input)
        }
    )
}

function checkForHealthCheckLabel(input){
    return new Promise(
        function(resolve,reject){

            //We create a structure like that
            //checks[port_number].id
            //checks[port_number].name
            //checks[port_number].http
            //...
            var checks = {};

            for (var key in input.metadata.labels) {
                if (input.metadata.labels.hasOwnProperty(key)) {

                    //Check if SERVICE_XXX_CHECK_HTTP is there
                    var checkPattern = /SERVICE_(\d+)_CHECK_HTTP/g;
                    var checkMatch = checkPattern.exec(key);

                    //indice 1 of checkMatch contains the private port number
                    if(checkMatch){

                        //stucture init for the captured port
                        if(!checks[checkMatch[1]])
                            checks[checkMatch[1]] = {};

                        var obj = jsonQuery('portMapping[privatePort=' + checkMatch[1] + ']', {
                            data: {"portMapping":input.metadata.portMapping}
                        });

                        checks[checkMatch[1]].id =  input.metadata.name + "_" + checkMatch[0];
                        checks[checkMatch[1]].name =  input.metadata.name + "_" + checkMatch[0];
                        checks[checkMatch[1]].http = "http://localhost:" + obj.value.publicPort + input.metadata.labels[key];
                        checks[checkMatch[1]].interval = "10s";
                        checks[checkMatch[1]].timeout = "1s";

                    }

                    //Then, check if SERVICE_XXX_CHECK_INTERVAL is there
                    var intervalPattern = /SERVICE_(\d+)_CHECK_INTERVAL/g;
                    var intervalMatch = intervalPattern.exec(key);

                    if(intervalMatch){

                        if(!checks[intervalMatch[1]])
                            checks[intervalMatch[1]] = {};

                        checks[intervalMatch[1]].interval =  input.metadata.labels[key];
                    }

                    //Then, check if SERVICE_XXX_CHECK_TIMEOUT is there
                    var timeoutPattern = /SERVICE_(\d+)_CHECK_TIMEOUT/g;
                    var timeoutMatch = timeoutPattern.exec(key);

                    if(timeoutMatch){

                        if(!checks[timeoutMatch[1]])
                            checks[timeoutMatch[1]] = {};

                        var obj = jsonQuery('portMapping[privatePort=' + timeoutMatch[1] + ']', {
                            data: {"portMapping":input.metadata.portMapping}
                        });

                        checks[timeoutMatch[1]].timeout =  input.metadata.labels[key];
                    }
                }
            }

             //Add checks in metadata for each port mapping
             input.metadata.portMapping.forEach(function(item){
                if(checks[item.privatePort])
                    item.Check = checks[item.privatePort];
             })

            resolve(input)
        }
    )
}

async function registerService(input) {
    console.log("registerService: " + input.servicename);

    var serviceDefs = [],
        hostUuid = await getHostUUID();

    input.metadata.portMapping.forEach(function(pm) {
        if(_ignoreUnnamedServices === true && (input.metadata.labels.SERVICE_NAME || input.metadata.port_service_names[pm.privatePort] || '').length == 0)
            return console.log('Service ignored as Service_Name is not defined ' + input.metadata.servicename);; 

        var id = hostUuid + ":" + input.metadata.uuid + ":" + pm.publicPort;
        var name = _prefix + input.metadata.service_name;
        var tags = [].concat(input.metadata.service_tags || [], _baseTags);

        var hasPortName = false;
        if (input.metadata.port_service_names[pm.privatePort] != undefined) {
            name = _prefix + input.metadata.port_service_names[pm.privatePort]
            hasPortName = true;
        }
        if (pm.transport == "udp")
            id += ":udp";

        if (input.metadata.portMapping.length > 1 && !hasPortName)
            name += "-" + pm.privatePort;

        var definition = {
            "ID": id, //<hostuuid>:<uuid>:<exposed-port>[:udp if udp]
            "Name": name,
            "Address": pm.address,
            "Port": parseInt(pm.publicPort)
        };

        definition.Tags = Array.from(
            new Set(tags).values() // unique list
        );

        if(pm.Check){
            definition.Check = pm.Check;
        }

        serviceDefs.push(definition)

    })

    let results = await Promise.all(
        serviceDefs.map(doRegister)
    );

    return serviceDefs.map((serviceDef, index) => {
        return `${serviceDef.ID} ${results[index] ? 'registered' : 'failed'}`;
    });
}

async function deregisterService(input){    
    var uniqueIDs = [],
        hostUuid = await getHostUUID();

    input.metadata.portMapping.forEach(function(pm){
        var id = hostUuid + ":" + input.metadata.uuid + ":" + pm.publicPort;

        if(pm.transport == "udp")
            id += ":udp";

        uniqueIDs.push(id)
    });

    return deregisterServices(uniqueIDs);
}

async function deregisterServices(uniqueIDs){
    let results = await Promise.all(
        uniqueIDs.map(doDeregister)
    );

    return uniqueIDs.map((id, index) => {
        return `${id} ${results[index] ? 'deregistered' : 'failed'}`;
    })
}

async function doRegister(serviceDef) {
    try {
        let response = await request({
            method:"PUT",
            url: _consulAgent + "/v1/agent/service/register",
            headers: {
                'Content-Type': 'application/json',
                'X-Consul-Token': _consulToken || undefined
            },
            json:serviceDef,
            resolveWithFullResponse: true
        }),
        body = JSON.parse(response.body || null);

        return true;
    }
    catch(err) {
        console.log("registerService error : " + err);

        return false;
    }
}

async function doDeregister(uuid) {
    try {
        let response = await request({
                method:"GET",
                url: _consulAgent + "/v1/agent/service/deregister/" + uuid,
                headers: {
                    'Accept': 'application/json',
                    'X-Consul-Token': _consulToken || undefined
                },
                resolveWithFullResponse: true
            }),
            body = JSON.parse(response.body || null);

        return true;
    }
    catch(err) {
        console.log('deregisterService error : ' + err);

        return false;
    }
}

async function getServices(hostUuid) {
    let response = await request({
            method: "GET",
            url: _consulAgent + "/v1/agent/services",
            headers: {
                'Accept': 'application/json',
                'X-Consul-Token': _consulToken || undefined
            },
            resolveWithFullResponse: true
        }),
        body = JSON.parse(response.body);

    var regex = new RegExp('^([a-zA-Z0-9][a-zA-Z0-9_.-]+):([a-zA-Z0-9][a-zA-Z0-9_.-]+):[0-9]+(?::udp)?$');      

    if(!hostUuid)
        hostUuid = await getHostUUID();

    return Object.values(body)
        .map(service => {
            var match = regex.exec(service.ID),
                meta = {
                    hostUuid: null,
                    id: null
                }
            
            if(match) {
                meta.hostUuid = match[1];
                meta.id = match[2];
            }

            return Object.assign(service, { meta });
        })
        .filter(service => {
            return service.meta && service.meta.hostUuid == hostUuid;
        });
}

async function getServiceByRancherId(uuid){
    let services = (await getServices())
        .filter(service => service.meta.id == uuid);

    if(services.length == 1)
        return services[0];

    return null;
}

async function getServiceById(id){
    let services = (await getServices())
        .filter(service => service.ID == id);

    if(services.length == 1)
        return services[0];

    return null;
}