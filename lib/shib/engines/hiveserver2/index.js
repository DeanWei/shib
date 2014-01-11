var thrift = require('node-thrift')
  , ttransport = require('node-thrift/lib/thrift/transport')
  , ThriftHive = require('./TCLIService')
  , TTypes = require('./TCLIService_types');

var MaxRows = 100000;
var OperationStatusPollingInterval = 1000; // 1sec

var runningOperations = {}; // For Monitor methods

var NotSupportedOptionError = exports.NotSupportedOptionError = function(){};

var Executer = exports.Executer = function(conf){
  if (conf.name !== 'hiveserver2')
    throw "executer name mismatch for hiveserver2:" + conf.name;

  /* hive.server2.authentication='NOSASL' or SASLTransport ... */
  this._connection = thrift.createConnection(
    conf.host,
    conf.port,
    {transport: ttransport.TBufferedTransport}
  );
  this._client = thrift.createClient(ThriftHive, this._connection);
  this._sessionHandle = null;
  this._maxRows = conf['maxRows'] || MaxRows;

  if (conf.support_database) {
    throw new NotSupportedOptionError();
  }
};

Executer.prototype._inSession = function(callback){
  if (this._sessionHandle) {
    callback(null); return;
  }
  var self = this;
  var openSessionReq = new TTypes.TOpenSessionReq({username: '', password: ''});
  this._client.OpenSession(openSessionReq, function(err, res){
    if (err) { callback(err); return; }
    if (! res.sessionHandle){ callback({message: "sessionHandle missing without any reason"}); return; }
    self._sessionHandle = res.sessionHandle;
    callback(null);
  });
};

Executer.prototype.end = function(){
  if (this._client) {
    var self = this;
    if (! this._sessionHandle) {
      this._connection.end();
      return;
    }
    var closeReq = new TTypes.TCloseSessionReq({sessionHandle: this._sessionHandle});
    this._client.CloseSession(closeReq, function(){ self._connection.end(); });
  }
};

Executer.prototype.supports = function(operation){
  switch (operation) {
  case 'setup':
  case 'execute':
    return true;
  }
  throw "unknown operation name (for hiveserver2.Executer):" + operation;
};

Executer.prototype.setup = function(setups, callback){
  if (!setups || setups.length < 1) {
    callback(null); return;
  }

  var self = this;
  var client = this._client;
  var setupQueue = setups.concat(); // shallow copy of Array to use as queue

  var executeSetup = function(queue, callback){
    var q = queue.shift();
    self.execute(null, q, function(err, fetcher){
      if (err)
        callback(err);
      else
        fetcher.fetch(null,function(err,rows){
          if (err) { callback(err); return; }
          if (queue.length > 0)
            executeSetup(queue, callback);
          else
            callback(null);
        });
    });
  };

  this._inSession(function(err){
    if (err){ callback(err); return; }
    executeSetup(setupQueue, callback);
  });
};

Executer.prototype.execute = function(jobname, query, callback){
  var self = this;
  var client = this._client;

  /* confOverlay argument of TExecuteStatementReq doesn't works with 'mapred.job.name' and 'mapreduce.job.name' ... */
  var setJobName = [];
  if (jobname && jobname !== '') {
    setJobName.push('set mapred.job.name=' + jobname);
    setJobName.push('set mapreduce.job.name=' + jobname);
  }
  this._inSession(function(err){
    if (err) { callback(err); return; }
    self.setup(setJobName, function(err){
      if (err) { callback(err); return; }
      var executeReq = new TTypes.TExecuteStatementReq({sessionHandle:self._sessionHandle, statement:query});
      client.ExecuteStatement(executeReq, function(err, res){
        if (err) { callback(err); return; }
        /*
ttypes.TStatusCode = {
'SUCCESS_STATUS' : 0,
'SUCCESS_WITH_INFO_STATUS' : 1,
'STILL_EXECUTING_STATUS' : 2,
'ERROR_STATUS' : 3,
'INVALID_HANDLE_STATUS' : 4
};
ttypes.TOperationState = {
'INITIALIZED_STATE' : 0,
'RUNNING_STATE' : 1,
'FINISHED_STATE' : 2,
'CANCELED_STATE' : 3,
'CLOSED_STATE' : 4,
'ERROR_STATE' : 5,
'UKNOWN_STATE' : 6
};
         */
        if (!res || !res['status'] || res.status['statusCode'] !== TTypes.TStatusCode['SUCCESS_STATUS']) {
          console.log({message:"Failed to execute statement", res:res});
          callback({message:"Failed to execute statement:" + res.status.errorMessage});
          /*
          var resExample1 = { status:
            { statusCode: 3,
              infoMessages: null,
              sqlState: '08S01',
              errorCode: 1,
              errorMessage: 'Error while processing statement: FAILED: Execution Error, return code 1 from org.apache.hadoop.hive.ql.exec.MapRedTask' },
            operationHandle: null
          };
           */
          return;
        }
        if (! res['operationHandle']) {
          console.log({message:"operationHandle missing for query"});
          callback({message:"operationHandle missing for query"});
          return;
        }
        // fetch operation fesult
        callback(null, new Fetcher(client, res.operationHandle, self._maxRows));
      });
    });
  });
};

var Fetcher = function(client, operationHandle, maxRows){
  this._client = client;
  this._oph = operationHandle;
  this._opStatus = null;
  this._noMoreResults = false;
  this._maxRows = maxRows;

  this._typeName = function(num) {
    // ttypes.TTypeId = {
    switch (num) {
      case  0: return 'boolean'; // 'BOOLEAN_TYPE' : 0,
      case  1: return 'tinyint'; // 'TINYINT_TYPE' : 1,
      case  2: return 'smallint'; // 'SMALLINT_TYPE' : 2,
      case  3: return 'int'; // 'INT_TYPE' : 3,
      case  4: return 'bigint'; // 'BIGINT_TYPE' : 4,
      case  5: return 'float'; // 'FLOAT_TYPE' : 5,
      case  6: return 'double'; // 'DOUBLE_TYPE' : 6,
      case  7: return 'string'; // 'STRING_TYPE' : 7,
      case  8: return 'timestamp'; // 'TIMESTAMP_TYPE' : 8,
      case  9: return 'binary'; // 'BINARY_TYPE' : 9,
      case 10: return 'array'; // 'ARRAY_TYPE' : 10,
      case 11: return 'map'; // 'MAP_TYPE' : 11,
      case 12: return 'struct'; // 'STRUCT_TYPE' : 12,
      case 13: return 'union'; // 'UNION_TYPE' : 13,
      case 14: return 'userdefined'; // 'USER_DEFINED_TYPE' : 14,
      case 15: return 'decimal'; // 'DECIMAL_TYPE' : 15
    }
    // };
    return "unknown(" + String(num) + ")";
  };

  this.schema = function(callback){
    var self = this;
    var req = new TTypes.TGetResultSetMetadataReq({operationHandle: this._oph});
    this._client.GetResultSetMetadata(req, function(err,res){
      if (err) { callback(err); return; }
/*
 * schema(callback): callback(err, schema)
 *  schema: {fieldSchemas: [{name:'fieldname1'}, {name:'fieldname2'}, {name:'fieldname3'}, ...]}
 *  //?? schema: [{name:'fieldname1'}, {name:'fieldname2'}, ...]
 */
      //TODO: res.status ?
      var result = {
        fieldSchemas: res.schema.columns.map(function(c){
          var colname = c.columnName;
          var coltypeNum = c.typeDesc["types"][0]["primitiveEntry"]["type"];
          return {name:colname, type:self._typeName(coltypeNum)};
        })
      };
      callback(null, result);
/* res.schema
{
  "columns": [
    { "columnName": "service",
      "typeDesc": {
        "types": [
          { "primitiveEntry": { "type": 7 },
            "arrayEntry": null,
            "mapEntry": null,
            "structEntry": null,
            "unionEntry": null,
            "userDefinedTypeEntry": null }
        ]
      },
      "position": 1,
      "comment": null
    },
    { "columnName": "cnt",
      "typeDesc": {
        "types": [
          { "primitiveEntry": { "type": 4 },
            "arrayEntry": null,
            "mapEntry": null,
            "structEntry": null,
            "unionEntry": null,
            "userDefinedTypeEntry": null
          }
        ]
      },
      "position": 2,
      "comment": null
    }
  ]
}
 */

    });
  };

  // stringify value of each columns
  this._colValue = function(obj) {
    /*
    colVals = [
      { "boolVal": null, "byteVal": null, "i16Val": null, "i32Val": null, "i64Val": null, "doubleVal": null,
        "stringVal": { "value": "blog" } },
      { "boolVal": null, "byteVal": null, "i16Val": null, "i32Val": null,
        "i64Val": { "value": { "buffer": [0, 0, 0, 0, 63, 218, 72, 34], "offset": 0 } },
        "doubleVal": null, "stringVal": null },
      { "boolVal": { "value": false },
        "byteVal": null, "i16Val": null, "i32Val": null, "i64Val": null, "doubleVal": null, "stringVal": null },
      { "boolVal": null, "byteVal": null, "i16Val": null, "i32Val": null, "i64Val": null,
        "doubleVal": { "value": 0.01 },
        "stringVal": null },
      { "boolVal": null, "byteVal": null, "i16Val": null,
        "i32Val": { "value": 1 },
        "i64Val": null, "doubleVal": null, "stringVal": null },
      { "boolVal": null, "byteVal": null, "i16Val": null, "i32Val": null, "i64Val": null, "doubleVal": null,
        "stringVal": { "value": "[1, 2, 3]" } }
    ]
     */
    if (obj['stringVal'] !== null) {
      var s = obj.stringVal['value'];
      if (s === null)
        return 'NULL';
      return s;
    }

    if (obj['boolVal'] !== null) {
      return String(obj.boolVal['value']).toUpperCase();
    }

    // rest are numerics, or NULL
    // byteVal, i16Val, i32Val, i64Val, doubleVal
    var value = null;

    if (obj['i64Val'] !== null)
      value = obj.i64Val['value'];
    else if (obj['i32Val'] !== null)
      value = obj.i32Val['value'];
    else if (obj['i16Val'] !== null)
      value = obj.i16Val['value'];
    else if (obj['doubleVal'] !== null)
      value = obj.doubleVal['value'];
    else if (obj['byteVal'] !== null)
      value = obj.byteVal['value'];

    if (value === null || value === undefined)
      return 'NULL';

    if ((value instanceof Object) && (value['buffer'] instanceof Object)) {
      var shifts = 1;
      var buffer = value.buffer;
      var v = 0;
      // shift operator doesn't works for nums larger than 32bit
      for (var i = buffer.length - 1, s = 1; i >= 0; i--, s*= 256) {
        v += buffer[i] * s;
      }
      return v;
    }

    return value;
  };

  this.fetch = function(num, callback){
    if (!num) {
      this._fetchAll(callback);
      return;
    }

    var fetchNum = num;
    if (fetchNum > this._maxRows)
      fetchNum = this._maxRows;

    if (this._noMoreResults) {
      callback(null, null);
      this._closeOperation();
      return;
    }

    var self = this;
    this._waitComplete(function(err){
      if (err) {
        callback(err);
        self._closeOperation();
        return;
      }
      /*
       ttypes.TFetchOrientation = {
         'FETCH_NEXT' : 0,
         'FETCH_PRIOR' : 1,
         'FETCH_RELATIVE' : 2,
         'FETCH_ABSOLUTE' : 3,
         'FETCH_FIRST' : 4,
         'FETCH_LAST' : 5
       };
      */
      var orientation = TTypes.TFetchOrientation['FETCH_NEXT'];
      var req = new TTypes.TFetchResultsReq({operationHandle:self._oph, orientation:orientation, maxRows:num});
      self._client.FetchResults(req, function(err, res){
        if (err) {
          if (res['status'])
            console.log(JSON.stringify(res.status, null, " "));
          callback(err);
          self._closeOperation();
          return;
        }
        /*
        "status": {
          "statusCode": 0,
          "infoMessages": null,
          "sqlState": null,
          "errorCode": null,
          "errorMessage": null
        },
        "hasMoreRows": false,
        "results": {
          "startRowOffset": { "buffer": [0,0,0,0,0,0,0,0], "offset": 0 },
          "rows": [
            { "colVals": [ ... ] },
            { "colVals": [ ... ] }
          ],
          "columns": null
        }
         */
        /* hasMoreRows is always false !!!!!!!!!!!!!!!! */
        var fetchedRows = res.results.rows;
        var fetchedLength = fetchedRows.length;
        var rows = [];

        if (fetchedLength < 1) {
          self._noMoreResults = true;
        } else {
          for (var i = 0; i < fetchedLength; i++) {
            var cols = [];
            var colVals = fetchedRows[i].colVals;
            var colValsLength = colVals.length;
            for (var j = 0; j < colValsLength; j++) {
              cols.push(self._colValue(colVals[j]));
            }
            rows.push(cols.join("\t"));
          }
        }
        callback(null, rows);
      });
    });
  };

  this._fetchAll = function(callback){
    var r = [];
    var self = this;
    var fetcher = function(){
      self.fetch(self._maxRows, function(err, results){
        if (err) { callback(err); return; }
        if (results === null || results.length < 1 || results.length === 1 && results[0].length < 1) {
          callback(null, r);
          return;
        }
        r = r.concat(results);
        fetcher();
      });
    };
    fetcher();
  };

  this._closeOperation = function(callback){
    var req = new TTypes.TCloseOperationReq({operationHandle: this._oph});
    client.CloseOperation(req, function(err, res){
      if (callback) {
        callback();
      }
    });
  };

  this._waitComplete = function(callback){
    if (this._opStatus !== null) {
      callback(null);
      return;
    }

    var self = this;
    var oph = this._oph;
    var interval = OperationStatusPollingInterval;
    var client = this._client;
    var poller = function(){
      var req = new TTypes.TGetOperationStatusReq({operationHandle: oph});
      client.GetOperationStatus(req, function(err,res){
        if (err) { callback(err); return; }
/*
ttypes.TStatusCode = {
'SUCCESS_STATUS' : 0,
'SUCCESS_WITH_INFO_STATUS' : 1,
'STILL_EXECUTING_STATUS' : 2,
'ERROR_STATUS' : 3,
'INVALID_HANDLE_STATUS' : 4
};
ttypes.TOperationState = {
'INITIALIZED_STATE' : 0,
'RUNNING_STATE' : 1,
'FINISHED_STATE' : 2,
'CANCELED_STATE' : 3,
'CLOSED_STATE' : 4,
'ERROR_STATE' : 5,
'UKNOWN_STATE' : 6
};
 */
        var statusCode = res && res['operationState'];
        if (statusCode === TTypes.TOperationState['INITIALIZED_STATE'] ||
            statusCode === TTypes.TOperationState['RUNNING_STATE']) {
          setTimeout(poller, interval);
          return;
        }

        self._opStatus = statusCode;
        if (statusCode === TTypes.TOperationState['FINISHED_STATE']) {
          callback(null);
          return;
        }

        var msg;
        if (statusCode === TTypes.TOperationState['CANCELED_STATE'])
          msg = 'Query canceled';
        else if (statusCode === TTypes.TOperationState['CLOSED_STATE'])
          msg = 'Query closed';
        else if (statusCode === TTypes.TOperationState['ERROR_STATE'])
          msg = 'Query process ended with errror';
        else if (statusCode === TTypes.TOperationState['UNKNOWN_STATE'])
          msg = 'Query status unknown';
        else
          msg = 'Statement failed with unknown status:' + ' (' + String(statusCode) + ')';

        callback({message:msg, status:res.status});
        return;
      });
    };
    poller();
  };
};

// TODO: Monitor impl after interface fix