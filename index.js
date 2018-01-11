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
const _consulAgent = process.env.LOCAL_CONSUL_AGENT || "http://localhost:8500";

var _hostUuid = null;

Array.prototype.flatten = function() {
    var ret = [];
    for(var i = 0; i < this.length; i++) {
        if(Array.isArray(this[i])) {
            ret = ret.concat(this[i].flatten());
        } else {
            ret.push(this[i]);
        }
    }
    return ret;
};

emitter.start();

emitter.on("connect", async function() {
    try {
        console.log("connected to docker api");
        console.log("register existing containers");

        let services = await getServices(),
            hostUuid = await getHostUUID();

        console.log('host uuid' + hostUuid);
        console.log("services for node: " + services.length);

        await deregisterServices(services.map(service => service.ID));

        getHostContainers(hostUuid)
            .then(registerContainers)
            .then(function (value) {
                console.log(value);
            }).catch(function(err){
                console.error("Startup; " + err);
            })
    }
    catch(err) {
        console.error('Startup; ' + err);
    }
});

emitter.on('start', async function(evt){
    try {
        var name = evt.Actor.Attributes['io.rancher.container.name'] || evt.Actor.Attributes.name;
        console.log(new Date() + ' - container start ' + name + ' (image : '+evt.Actor.Attributes.image+')');
        getMetaData(name)
            .then(tryRegisterContainer)
            .then(function (value) {
                console.log(value);
            }).catch(function(err){
                console.error("Registering; " + err);
            })
    }
    catch(err) {
        console.error('Registering; ' + err);
    }
});

emitter.on('stop', async function(evt){
    try {
        var name = evt.Actor.Attributes['io.rancher.container.name'] || evt.Actor.Attributes.name;
        var uuid = evt.Actor.Attributes['io.rancher.container.uuid'];
        console.log(new Date() + ' - container stop ' + name + ' (image : '+evt.Actor.Attributes.image+')');

        //console.log(evt);

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

function getHostContainers(hostUUID){
    return new Promise(
        function(resolve,reject){
            //console.log("query for existing containers");

            var query = {
                "method":"GET",
                "url": "http://rancher-metadata/latest/containers",
                "headers":{
                    "accept" : "application/json"
                }
            }

            request(query,function (error, response, body) {
                if (error) {
                    reject("getHostContainers error : " + error);
                }

                var output = {};
                output.containers = JSON.parse(body).filter(
                    function(container) {
                        return container.host_uuid == hostUUID;
                    }
                );
                resolve(output);
            })
        }
    )
}

function registerContainers(input) {
    var promises = [];

    for (let container of input.containers) {
        var temp = {};
        temp.metadata = container;
        temp.servicename = container.name;

        promises.push(tryRegisterContainer(temp));
    }
    
    return Promise.all(promises)
        .then(value => {
            return Promise.resolve(value.flatten().filter(Boolean));
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
        })
}

function getMetaData(servicename){
    return new Promise(
        function(resolve,reject){
            var query = {
                "method":"GET",
                "url": "http://rancher-metadata/latest/containers/" + servicename,
                "headers":{
                    "accept" : "application/json"
                }
            }

            request(query,function (error, response, body) {
                if (error) {
                    reject("getMetaData error : " + error);
                }

                var output = {};
                output.metadata = JSON.parse(body);
                output.servicename = servicename;
                resolve(output);
            })
        }
    )
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
            if(input.metadata.labels.SERVICE_TAGS){
                console.log("Service_Tags found");
                input.metadata.service_tags = input.metadata.labels.SERVICE_TAGS.split(",");
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
        var id = hostUuid + ":" + input.metadata.uuid + ":" + pm.publicPort;
        var name = _prefix + input.metadata.service_name;
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

        if (input.metadata.service_tags) {
            definition.Tags = input.metadata.service_tags;
        }

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
    uniqueIDs = []
        .concat(uniqueIDs)
        .filter(id => id && id.length > 32);

    let results = await Promise.all(
        uniqueIDs.map(doDeregister)
    );

    return uniqueIDs.map((id, index) => {
        return `${id} ${results[index]} ? 'deregistered' : 'failed'}`;
    })
}

async function doRegister(serviceDef) {
    try {
        let response = await request({
            method:"PUT",
            url: _consulAgent + "/v1/agent/service/register",
            headers:{
                "Content-Type" : "application/json"
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
            "method": "GET",
            "url": _consulAgent + "/v1/agent/services",
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
    let services = await getServices()
        .filter(service => service.rancherId == uuid);

    if(services.length == 1)
        return services[0];

    return null;
}

async function getServiceById(id){
    let services = await getServices()
        .filter(service => service.ID == id);

    if(services.length == 1)
        return services[0];

    return null;
}