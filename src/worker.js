/*
 * Copyright 2014-2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Amazon Software License (the "License"). You may not use
 * this file except in compliance with the License. A copy of the License is
 * located at
 *
 *    http://aws.amazon.com/asl/
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express
 * or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */
(function() {
   var global = this;
   connect = global.connect || {};
   global.connect = connect;
   global.lily = connect;

   connect.worker = {};

   var GET_AGENT_TIMEOUT = 30000;
   var GET_AGENT_RECOVERY_TIMEOUT = 5000;
   var GET_AGENT_SUCCESS_TIMEOUT = 100;
   var LOG_BUFFER_CAP_SIZE = 400;

   var GET_AGENT_CONFIGURATION_INTERVAL = 30000;      // 30sec

   /**-----------------------------------------------------------------------*/
   var MasterTopicCoordinator = function() {
      this.topicMasterMap = {};
   };

   MasterTopicCoordinator.prototype.getMaster = function(topic) {
      connect.assertNotNull(topic, 'topic');
      return this.topicMasterMap[topic] || null;
   };

   MasterTopicCoordinator.prototype.setMaster = function(topic, id) {
      connect.assertNotNull(topic, 'topic');
      connect.assertNotNull(id, 'id');
      this.topicMasterMap[topic] = id;
   };

   MasterTopicCoordinator.prototype.removeMaster = function(id) {
      connect.assertNotNull(id, 'id');
      var self = this;

      connect.entries(this.topicMasterMap).filter(function(entry) {
         return entry.value === id;
      }).forEach(function(entry) {
         delete self.topicMasterMap[entry.key];
      });
   };

   /**-------------------------------------------------------------------------
    * The object responsible for polling and passing data downstream to all
    * consumer ports.
    */
   var ClientEngine = function() {
      var self = this;

      this.client = null;
      this.multiplexer = new connect.StreamMultiplexer();
      this.conduit = new connect.Conduit("AmazonConnectSharedWorker", null, this.multiplexer);
      this.timeout = null;
      this.agent = null;
      this.nextToken = null;
      this.initData = {};
      this.portConduitMap = {};
      this.masterCoord = new MasterTopicCoordinator();
      this.logsBuffer = [];

      connect.rootLogger = new connect.DownstreamConduitLogger(this.conduit);

      this.conduit.onDownstream(connect.EventType.SEND_LOGS, function(logsToUpload) {
         self.logsBuffer = self.logsBuffer.concat(logsToUpload);
         //only call API to send logs if buffer reached cap
         if (self.logsBuffer.length > LOG_BUFFER_CAP_SIZE) {
            self.handleSendLogsRequest(self.logsBuffer);
         }
      });
      this.conduit.onDownstream(connect.EventType.CONFIGURE, function(data) {
         if (data.authToken && data.authToken !== self.initData.authToken) {
            self.initData = data;
            connect.core.init(data);

            // Start polling for agent data.
            self.pollForAgent();
            self.pollForAgentConfiguration({repeatForever: true});
         }
      });
      this.conduit.onDownstream(connect.EventType.TERMINATE, function() {
         //upload pending logs before terminating.
         self.handleSendLogsRequest(self.logsBuffer);
         connect.core.terminate();
         self.conduit.sendDownstream(connect.EventType.TERMINATED);
      });
      this.conduit.onDownstream(connect.EventType.SYNCHRONIZE, function() {
         self.conduit.sendDownstream(connect.EventType.ACKNOWLEDGE);
      });

      /**
       * Called when a consumer port connects to this SharedWorker.
       * Let's add them to our multiplexer.
       */
      global.onconnect = function(event) {
         var port = event.ports[0];
         var stream = new connect.PortStream(port);
         self.multiplexer.addStream(stream);
         port.start();

         var portConduit = new connect.Conduit(stream.getId(), null, stream);
         portConduit.sendDownstream(connect.EventType.ACKNOWLEDGE, {id: stream.getId()});

         self.portConduitMap[stream.getId()] = portConduit;

         if (self.agent !== null) {
            portConduit.sendDownstream(connect.AgentEvents.UPDATE, self.agent);
         }

         portConduit.onDownstream(connect.EventType.API_REQUEST,
               connect.hitch(self, self.handleAPIRequest, portConduit));
         portConduit.onDownstream(connect.EventType.MASTER_REQUEST,
               connect.hitch(self, self.handleMasterRequest, portConduit, stream.getId()));
         portConduit.onDownstream(connect.EventType.RELOAD_AGENT_CONFIGURATION,
               connect.hitch(self, self.pollForAgentConfiguration));
         portConduit.onDownstream(connect.EventType.CLOSE, function() {
            self.multiplexer.removeStream(stream);
            delete self.portConduitMap[stream.getId()];
            self.masterCoord.removeMaster(stream.getId());
         });
      };
   };

   ClientEngine.prototype.pollForAgent = function() {
      var self = this;
      var client = connect.core.getClient();

      this.checkAuthToken();

      client.call(connect.ClientMethods.GET_AGENT_SNAPSHOT, {
         nextToken:     self.nextToken,
         timeout:       GET_AGENT_TIMEOUT
      }, {
         success: function(data) {
            self.agent = self.agent || {};
            self.agent.snapshot = data.snapshot;
            self.nextToken = data.nextToken;
            self.updateAgent();
            global.setTimeout(connect.hitch(self, self.pollForAgent), GET_AGENT_SUCCESS_TIMEOUT);
         },
         failure: function(err, data) {
            try {
               connect.getLog().error("Failed to get agent data.")
                  .withObject({
                     err: err,
                     data: data
                  });

            } finally {
               global.setTimeout(connect.hitch(self, self.pollForAgent), GET_AGENT_RECOVERY_TIMEOUT);
            }
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });

   };

   ClientEngine.prototype.pollForAgentConfiguration = function(paramsIn) {
      var self = this;
      var client = connect.core.getClient();
      var params = paramsIn || {};

      client.call(connect.ClientMethods.GET_AGENT_CONFIGURATION, {}, {
         success: function(data) {
            var configuration = data.configuration;
            self.pollForAgentPermissions(configuration);
            self.pollForAgentStates(configuration);
            self.pollForDialableCountryCodes(configuration);
            self.pollForRoutingProfileQueues(configuration);
            if (params.repeatForever) {
               global.setTimeout(connect.hitch(self, self.pollForAgentConfiguration, params),
                  GET_AGENT_CONFIGURATION_INTERVAL);
            }
         },
         failure: function(err, data) {
            try {
               connect.getLog().error("Failed to fetch agent configuration data.")
                  .withObject({
                     err: err,
                     data: data
                  });
            } finally {
               if (params.repeatForever) {
                  global.setTimeout(connect.hitch(self, self.pollForAgentConfiguration),
                     GET_AGENT_CONFIGURATION_INTERVAL, params);
               }
            }
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   ClientEngine.prototype.pollForAgentStates = function(configuration, paramsIn) {
      var self = this;
      var client = connect.core.getClient();
      var params = paramsIn || {};
      params.maxResults = params.maxResults || connect.DEFAULT_BATCH_SIZE;

      client.call(connect.ClientMethods.GET_AGENT_STATES, {
         nextToken: params.nextToken || null,
         maxResults: params.maxResults

      }, {
         success: function(data) {
            if (data.nextToken) {
               self.pollForAgentStates(configuration, {
                  states:   (params.states || []).concat(data.states),
                  nextToken:     data.nextToken,
                  maxResults:    params.maxResults
               });

            } else {
               configuration.agentStates = (params.states || []).concat(data.states);
               self.updateAgentConfiguration(configuration);
            }
         },
         failure: function(err, data) {
            connect.getLog().error("Failed to fetch agent states list.")
               .withObject({
                  err: err,
                  data: data
               });
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   ClientEngine.prototype.pollForAgentPermissions = function(configuration, paramsIn) {
      var self = this;
      var client = connect.core.getClient();
      var params = paramsIn || {};
      params.maxResults = params.maxResults || connect.DEFAULT_BATCH_SIZE;

      client.call(connect.ClientMethods.GET_AGENT_PERMISSIONS, {
         nextToken: params.nextToken || null,
         maxResults: params.maxResults

      }, {
         success: function(data) {
            if (data.nextToken) {
               self.pollForAgentPermissions(configuration, {
                  permissions:   (params.permissions || []).concat(data.permissions),
                  nextToken:     data.nextToken,
                  maxResults:    params.maxResults
               });

            } else {
               configuration.permissions = (params.permissions || []).concat(data.permissions);
               self.updateAgentConfiguration(configuration);
            }
         },
         failure: function(err, data) {
            connect.getLog().error("Failed to fetch agent permissions list.")
               .withObject({
                  err: err,
                  data: data
               });
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   ClientEngine.prototype.pollForDialableCountryCodes = function(configuration, paramsIn) {
      var self = this;
      var client = connect.core.getClient();
      var params = paramsIn || {};
      params.maxResults = params.maxResults || connect.DEFAULT_BATCH_SIZE;

      client.call(connect.ClientMethods.GET_DIALABLE_COUNTRY_CODES, {
         nextToken: params.nextToken || null,
         maxResults: params.maxResults
      }, {
         success: function(data) {
            if (data.nextToken) {
               self.pollForDialableCountryCodes(configuration, {
                  countryCodes:  (params.countryCodes || []).concat(data.countryCodes),
                  nextToken:     data.nextToken,
                  maxResults:    params.maxResults
               });

            } else {
               configuration.dialableCountries = (params.countryCodes || []).concat(data.countryCodes);
               self.updateAgentConfiguration(configuration);
            }
         },
         failure: function(err, data) {
            connect.getLog().error("Failed to fetch dialable country codes list.")
               .withObject({
                  err: err,
                  data: data
               });
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   ClientEngine.prototype.pollForRoutingProfileQueues = function(configuration, paramsIn) {
      var self = this;
      var client = connect.core.getClient();
      var params = paramsIn || {};
      params.maxResults = params.maxResults || connect.DEFAULT_BATCH_SIZE;

      client.call(connect.ClientMethods.GET_ROUTING_PROFILE_QUEUES, {
         routingProfileARN: configuration.routingProfile.routingProfileARN,
         nextToken: params.nextToken || null,
         maxResults: params.maxResults
      }, {
         success: function(data) {
            if (data.nextToken) {
               self.pollForRoutingProfileQueues(configuration, {
                  countryCodes:  (params.queues || []).concat(data.queues),
                  nextToken:     data.nextToken,
                  maxResults:    params.maxResults
               });

            } else {
               configuration.routingProfile.queues = (params.queues || []).concat(data.queues);
               self.updateAgentConfiguration(configuration);
            }
         },
         failure: function(err, data) {
            connect.getLog().error("Failed to fetch routing profile queues list.")
               .withObject({
                  err: err,
                  data: data
               });
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   ClientEngine.prototype.handleAPIRequest = function(portConduit, request) {
      var self = this;
      var client = connect.core.getClient();

      client.call(request.method, request.params, {
         success: function(data) {
            var response = connect.EventFactory.createResponse(connect.EventType.API_RESPONSE, request, data);
            portConduit.sendDownstream(response.event, response);
         },
         failure: function(err, data) {
            var response = connect.EventFactory.createResponse(connect.EventType.API_RESPONSE, request, data, JSON.stringify(err));
            portConduit.sendDownstream(response.event, response);
            connect.getLog().error("'%s' API request failed: %s", request.method, err)
               .withObject({request: request, response: response});
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   /**
    * Handle incoming master query or modification requests from connected tab ports.
    */
   ClientEngine.prototype.handleMasterRequest = function(portConduit, portId, request) {
      var response = null;

      switch(request.method) {
      case connect.MasterMethods.BECOME_MASTER:
         this.masterCoord.setMaster(request.params.topic, portId);
         response = connect.EventFactory.createResponse(connect.EventType.MASTER_RESPONSE, request, {
            masterId:   portId,
            isMaster:   true,
            topic:      request.params.topic
         });

         break;

      case connect.MasterMethods.CHECK_MASTER:
         var masterId = this.masterCoord.getMaster(request.params.topic);
         if (!masterId) {
            this.masterCoord.setMaster(request.params.topic, portId);
            masterId = portId;
         }

         response = connect.EventFactory.createResponse(connect.EventType.MASTER_RESPONSE, request, {
            masterId:   masterId,
            isMaster:   portId === masterId,
            topic:      request.params.topic
         });

         break;

      default:
         throw new Error("Unknown master method: " + request.method);
      }

      portConduit.sendDownstream(response.event, response);
   };

   ClientEngine.prototype.updateAgentConfiguration = function(configuration) {
      if (configuration.permissions &&
          configuration.dialableCountries &&
          configuration.agentStates &&
          configuration.routingProfile.queues) {

         this.agent = this.agent || {};
         this.agent.configuration = configuration;
         this.updateAgent();

      } else {
         connect.getLog().trace("Waiting to update agent configuration until all config data has been fetched.");
      }
   };

   ClientEngine.prototype.updateAgent = function() {
      if (! this.agent) {
         connect.getLog().trace("Waiting to update agent until the agent has been fully constructed.");

      } else if (! this.agent.snapshot) {
         connect.getLog().trace("Waiting to update agent until the agent snapshot is available.");

      } else if (! this.agent.configuration) {
         connect.getLog().trace("Waiting to update agent until the agent configuration is available.");

      } else {
         // Alias some of the properties for backwards compatibility.
         this.agent.snapshot.status = this.agent.state;
         this.agent.snapshot.contacts.forEach(function(contact) {
            contact.status = contact.state;

            contact.connections.forEach(function(connection) {
               connection.address = connection.endpoint;
            });
         });

         this.agent.configuration.routingProfile.defaultOutboundQueue.queueId =
            this.agent.configuration.routingProfile.defaultOutboundQueue.queueARN;
         this.agent.configuration.routingProfile.queues.forEach(function(queue) {
            queue.queueId = queue.queueARN;
         });
         this.agent.snapshot.contacts.forEach(function(contact) {
            //contact.queue is null when monitoring
            if (contact.queue !== undefined) {
                contact.queue.queueId = contact.queue.queueARN;
            }
         });
         this.agent.configuration.routingProfile.routingProfileId =
            this.agent.configuration.routingProfile.routingProfileARN;

         this.conduit.sendDownstream(connect.AgentEvents.UPDATE, this.agent);
      }
   };

   /**
    * Send a message downstream to all consumers when we detect that authentication
    * against one of our APIs has failed.
    */
   ClientEngine.prototype.handleSendLogsRequest = function() {
      var self = this;
      var client = connect.core.getClient();
      var logEvents = [];
      var logsToSend = self.logsBuffer.slice();
      self.logsBuffer = [];
      logsToSend.forEach(function(log) {
         logEvents.push({
            timestamp:  log.time,
            component:  log.component,
            message: log.text
         });
      });
      client.call(connect.ClientMethods.SEND_CLIENT_LOGS, {logEvents: logEvents}, {
         success: function(data) {
            connect.getLog().info("SendLogs request succeeded.");
         },
         failure: function(err, data) {
            connect.getLog().error("SendLogs request failed. %s", err);
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   ClientEngine.prototype.handleAuthFail = function() {
      var self = this;
      self.conduit.sendDownstream(connect.EventType.AUTH_FAIL);
   };

   ClientEngine.prototype.checkAuthToken = function() {
      var self = this;
      var expirationDate = new Date(self.initData.authTokenExpiration);
      var currentTimeStamp = new Date().getTime();
      var fiveMins = 5 * 60 * 1000;

      // refresh token 5 minutes before expiration
      if (expirationDate.getTime() < (currentTimeStamp + fiveMins)) {
        this.refreshAuthToken();
      }
   };

   ClientEngine.prototype.refreshAuthToken = function() {
      var self = this;
      connect.assertNotNull(self.initData.refreshToken, 'initData.refreshToken');

      var client = connect.core.getClient();
      client.call(connect.ClientMethods.GET_NEW_AUTH_TOKEN, {refreshToken: self.initData.refreshToken}, {
         success: function(data) {
            connect.getLog().info("Get new auth token succeeded. New auth token expired at %s", data.expirationDateTime);
            self.initData.authToken = data.newAuthToken;
            self.initData.authTokenExpiration = new Date(data.expirationDateTime);
            connect.core.init(self.initData);
         },
         failure: function(err, data) {
            connect.getLog().error("Get new auth token failed. %s ", err);
         },
         authFailure: connect.hitch(self, self.handleAuthFail)
      });
   };

   /**-----------------------------------------------------------------------*/
   connect.worker.main = function() {
      connect.worker.clientEngine = new ClientEngine();
   };

})();
