/**
 * testem-multi-parallel
 *
 * @author sideroad
 * @author kongchen
 */
var net = require('net');
var testemAPI = require('testem');
var async = require('async');
var _ = require('underscore');
var fs = require('fs');
var BaseReporter = require('./reporter');
var Readable = require('stream').Readable;
var util = require('util');
var events = require('events');
var path = require('path');
var mkdirp = require('mkdirp');
var coverage = require('./coverage_middleware');
var bodyParser = require('body-parser');

(function () {
    "use strict";

    var waitQ = [], runningQ = [], browserQ = [], doneQ = [];
    var bailOut = false;
    var Runner = function (config) {
        this.config = _.clone(config);
        delete this.config.files;
        this.output = _.extend({}, {
            // report passed tests
            pass: true,
            // report failed tests
            fail: true,
            // where to write the coverage report
            coverage: false
        }, config.output);

        if (this.output.coverage) {
            mkdirp.sync(this.output.coverage);
        }

        this.results = {
            test: [],
            ok: [],
            not: [],
            tests: 0,
            pass: 0,
            fail: 0,
            version: ""
        };
        this.tap = {
            ok: [],
            not: [],
            all: [],
            comments: []
        };

        this.bailedOut = false;

        this.stream = new Readable();
        this.stream._read = function () {
        };

        this.lastTestNumber = 0;

        this.baseTestemPath = path.join(
            path.dirname(require.resolve("testem")),
            "../"
        );

        events.EventEmitter.call(this);

    };

    util.inherits(Runner, events.EventEmitter);


    Runner.prototype.getConfig = function (extend) {
        var options = this.config;
        if (extend) {
            if (/\.json$/.test(extend)) {
                options = _.extend(this.config, JSON.parse(fs.readFileSync(extend, 'utf-8').replace(/\n/, '')));
            } else {
                options = _.extend(this.config, {test_page: extend + "#testem"});
            }
        }
        return options;
    };

    Runner.prototype.fullResult = function (data, path) {
        this.results.test = this.results.test.concat(data.test.map(prefixPath));
        this.results.ok = this.results.ok.concat(data.ok.map(prefixPath));
        this.results.not = this.results.not.concat(data.not.map(prefixPath));
        this.results.pass += data.pass;
        this.results.fail += data.fail;
        this.results.tests += data.tests;

        function prefixPath(item) {
            return path + " - " + item;
        }
    };

    Runner.prototype.createResult = function () {
        var version = "unknown version. sorry.";
        var packageJSON = this.baseTestemPath + "/package.json";
        if (fs.existsSync(packageJSON)) {
            version = require(packageJSON).version;
        }
        return {
            launcher: this.config.launch_in_ci.pop(),
            test_page: this.config.test_page.split("#")[0],
            details: this.results,
            tapdetails: this.tap
        };
    };

    Runner.prototype.testResult = function (test, path) {
        if (!test.ok && this.config.bailOut) {
            // Next tests will be skipped
            running.bailedOut = true;
        }
        var prefix = test.ok ? "ok" : "not ok";
        var casename = path + " - " + test.name;


        this.tap.all.push(casename);
        if (test.ok) {
            this.tap.ok.push(casename);
        } else {
            this.tap.not.push(casename);
        }

        this.stream.push(casename + "\n");
        running.emit("data", prefix + " " + casename);
    };


    var running;
    var suite = []
    exports.exec = function (config, jsonFile) {
        var json = jsonFile || "testem-multi.json",
            config = config || JSON.parse(fs.readFileSync(json, "utf-8").replace(/\n/, '')),
            pool_size = config.pool_size,
            browser = config.browser,
            bailOut = config.output.bailOut,
            browser_files = config.browserFiles,
            files = config.files || [''];

        var tasks = [];
        running = new Runner(config);

        files.forEach(function (file) {
            var arunning = new Runner(config);
            suite.push(arunning);
            var default_launcher = "phantomjs";

            arunning.files = file;

            if (isBrowserFile(file, browser_files)) {
                arunning.config.launch_in_ci = [browser];

                browserQ.push({
                    launcher: browser,
                    file: file,
                    func: function (callback) {
                        executeTest(arunning, file, wrapUp, callback);
                    }
                });
            } else {
                arunning.config.launch_in_ci = [default_launcher];
                waitQ.push({
                    launcher: default_launcher,
                    file: file,
                    func: function (callback) {

                        executeTest(arunning, file, wrapUp, callback);

                    }
                });

            }


        });

        console.log('There are ' + waitQ.length + ' tasks to be run by phantomjs and '+ browserQ.length + ' tasks to be ran by ' + browser);
        var total = waitQ.length + browserQ.length;
        var executor = (function (callback) {

            while (waitQ.length > 0 || runningQ.length > 0 || doneQ.length != total || browserQ.length > 0) {
                if (runningQ.length >= pool_size) {
                    //console.log(runningQ.length +'tasks in running queue, wait for next tick.');
                    setTimeout(function () {
                        executor(callback);
                    }, 100);
                    return;
                }

                //check running Q
                var task;
                var browserRunning = false;
                if(browserQ.length>0){
                    runningQ.forEach(function(ele) {
                        if(ele === browser) {
                            browserRunning = true;
                            return;
                        }
                    });
                    if(browserRunning) {
                        task = waitQ.pop();
                    } else {
                        task = browserQ.pop();
                    }
                } else {
                    task = waitQ.pop();
                }

                if (!task) {
                    setTimeout(function () {
                        executor(callback);
                    }, 100);
                    return;
                }
                //console.log(runningQ.length + ' tasks in running queue, fill in one: ' + task.file + ' using ' + task.launcher);
                runningQ.push(task.launcher);
                task.func(function (err, result) {
                    var index = -1;
                    for(var i = 0; i< runningQ.length; i++) {
                        //console.log(runningQ[i]  + " vs " + result.launcher);
                        if(runningQ[i] === result.launcher) {
                            index = i;
                            break;
                        }
                    }
                    if(index !== -1) {
                        //console.log("Removing " + runningQ[index] + " task");
                        runningQ.splice(index, 1);
                    } else{
                        console.log('ERROR!!!');
                    }

                    if (!err) {
                        running.emit("data",
                        "# Executing end " + result.test_page + ". " + runningQ.length + ' tasks running and '+ waitQ.length + ' + ' + browserQ.length + ' tasks pending.');
                        doneQ.push(result);
                    } else {
                        console.log('ERROR!!!');
                    }
                });

            }

            console.log("All done!" + doneQ.length);
            callback(null, doneQ);

        });


        // Make this method async and give time to register event listeners
        process.nextTick(function () {
            executor(function (err, results) {
                //merge results
                var result = {
                    launcher: "",
                    details: {
                        test: [],
                        ok: [],
                        not: [],
                        tests: 0,
                        pass: 0,
                        fail: 0,
                        version: ""
                    },
                    tapdetails: {
                        ok: [],
                        not: [],
                        all: [],
                        comments: []
                    }
                };

                var tapResult = [
                    "TAP version 13"
                ];
                tapResult.push("1..");
                var count = 1;
                results.forEach(function (res) {

                    result.details.test.concat(res.details.test);
                    result.details.ok.concat(res.details.ok);
                    result.details.not.concat(res.details.not);
                    result.details.tests += res.details.tests;
                    result.details.fail += res.details.fail;
                    result.details.pass += res.details.pass;
                    result.details.version = res.details.version;


                    res.tapdetails.ok.forEach(function (line) {
                        result.tapdetails.ok.push(line);
                        tapResult.push('ok ' + count + ' ' + line);
                        count++;
                    });
                    res.tapdetails.not.forEach(function (line) {
                        result.tapdetails.not.push(line);
                        tapResult.push('not ok ' + count + ' ' + line);
                        ++count;
                    });

                    result.tapdetails.all.concat(res.tapdetails.all);

                    result.tapdetails.comments.push(res.tapdetails.comments);
                });


                var tap = result.tapdetails;
                var tests = tap.all.length;
                tapResult[1] = '1...' + --count;

                var textResult = tapResult.join("\n");

                running.emit("exit", textResult, result.details);

            });

        });


        return running;
    };

    // Expose also the on method, it would be nicer not to do it :P
    exports.on = function () {
        if (running) {
            running.on.apply(running, arguments);
        }
        //suite.forEach(function(runner) {
        //    runner.on.apply(runner, arguments);
        //});
    };


    function executeTest(runner, path, callback, finishcb) {
        if (running.bailedOut) {
            var message = "# BAILED OUT: Skipping " + path;
            running.tap.comments.push(message);
            running.stream.push(message + "\n");
            running.emit("data", message);
            return callback(null, running, finishcb);
        }
        //console.log("======="+path);
        var options = runner.getConfig(path);
        var testemPath = 'testem.' + (new Date().getTime()) + '.' + Math.random() + '.json';

        runner.stream.push("# Executing " + path + "\n");
        running.emit("data", "# Executing start " + path);

        var handleException = function (ex) {
            console.error("Unchaught Expection while running Testem Multi", ex);
            fs.unlinkSync(testemPath);
        };


        startTestem(runner, testemPath, path, function (error, runner) {
            fs.unlinkSync(testemPath);
            process.removeListener('uncaughtException', handleException);
            callback(error, runner, finishcb);
        });

        process.once('uncaughtException', handleException);
    }

    var portrange = 45032;

    function getPort(file, runner, cb) {
        var port = portrange;
        portrange += 1;

        var server = net.createServer();
        server.listen(port, function (err) {
            server.once('close', function () {
                cb(file, runner, port);
            });
            server.close();
        });
        server.on('error', function (err) {
            getPort(file, runner, cb);
        });
    }

    function startTestem(myrunner, configFile, mypath, callback) {
        var start = function (path, runner, port) {
            var testem = new testemAPI();

            var output = runner.output;
            var reporter = new BaseReporter(output);
            reporter.on("finish", function (data) {
                runner.fullResult(data, path);

                done(null);
            });

            reporter.on("test", function (data) {
                runner.testResult(data, path);
            });

            var done = getCallback(callback, runner);

            try {
                configureExpress(runner);
            } catch (ex) {
                console.warn("Unable to configure express");
            }

            var options = myrunner.getConfig(mypath);
            options['port'] = port;
            fs.writeFileSync(configFile, JSON.stringify(options));

            testem.startCI({
                file: configFile,
                port: port,
                reporter: reporter
            }, function () {
                reporter.removeAllListeners("test");
                reporter.removeAllListeners("finish");
                done(null);
            });
        };

        getPort(mypath, myrunner, function (file, therunner, port) {

            start(file, therunner, port);
        });


    }

    function wrapUp(err, runner, finishcb) {
        var result = runner.createResult();
        if (finishcb) {

            finishcb(null, result);
        } else {
            console.log("*************" + result.tapdetails.all);
        }
    }

    // Generate a callback that must be called twice before actually calling back
    // This is needed to synchronize testem and reporter
    function getCallback(callback, runner) {
        var counter = 1;
        var back = function (err) {
            if (counter === 0) {
                callback(err, runner);
            } else {
                counter -= 1;
            }
        };
        return back;
    }

    function isBrowserFile(filepath, browserfile) {
        var result = false;
        browserfile.forEach(function (f) {
            if (f === filepath) {
                result = true;
                return;
            }
        });

        return result;

    }

    function configureExpress(runner) {
        // Hack into the server object to add middlewares
        var Server = require(runner.baseTestemPath + "/lib/server/index.js");
        var testem_configureExpress = Server.prototype.configureExpress;
        Server.prototype.configureExpress = function () {
            testem_configureExpress.apply(this, arguments);
            var express = this.express;

            if (runner.output.coverage) {
                // After configuring the basic options, add our custom middlewares
                express.use(coverage.testem);
                express.use(bodyParser.urlencoded({extended: false}));
                express.use(bodyParser.json({limit: "10mb"}));
                express.use(coverage.store.bind(runner));
            }

            // Add the error handler at the end of the chain
            process.nextTick(function () {
                // Handle connection reset errors silently (raised since node 0.10)
                express.use(function (err, req, res, next) {
                    if (err && err.code === "ECONNRESET") {
                        // Ignore this error
                        next();
                    } else {
                        // Propagate it
                        next(err);
                    }
                });
            });
        };
    }
})();
