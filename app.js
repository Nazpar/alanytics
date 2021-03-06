var fs = require("fs"),
    http = require("http"),
    config = require('./config/default.json'),
    xregexp = require("xregexp"),
    dbi = require("node-dbi"),
    redisClient = require("redis"),
    cronJob = require('cron').CronJob,
    util = require('util'),
    moment = require('moment')
    ;

// PROC CONTROL

function debug( msg ) {
    if( config.debug ) {
        util.debug( msg );
    }
}
function error( msg ) {
    console.error( msg );
}

process.title = "alanytics";
 
var PID_FILE
if( config.pid_dir ) {
    PID_FILE  = config.pid_dir + "/" + process.title + ".pid"
} else {
    PID_FILE  = "/var/run/alanytics/" + process.title + ".pid"
}
 
fs.writeFileSync( PID_FILE, process.pid + "\n" );
 
process.on("uncaughtException", function(err) {
  console.error("[uncaughtException]", err);
  return process.exit(1);
});
 
process.on("SIGTERM", function() {
  console.log("SIGTERM (killed by supervisord or another process management tool)");
  return process.exit(0);
});
 
process.on("SIGINT", function() {
  console.log("SIGINT");
  return process.exit(0);
});
 
process.on("exit", function() {
  return fs.unlink(PID_FILE);
});
 
//
// Your code start here
//
 
setInterval(function(){}, 1000);

// END PROC CONTROL

var red = redisClient.createClient( config.redis.port, config.redis.host );
red.on("error", function (err) {
    console.error("Error " + err);
});

dbconf = {
    host: config.database.host,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name
};
db = new dbi.DBWrapper( 'mysql', dbconf);
db.connect();

// set up alan!
var alan = fs.readFileSync( "alan.gif" );
var transpalan = fs.readFileSync( "transparent.gif" );

var collections = require( "./collections.json" );

var robots = require( './robots.js' );
var bladerunner = new robots.Bladerunner( "config/robots.iab", "abce" );

function format( sql, bind ) {
    sql = sql.replace( /\$([1-9]+)/g, function( match, p1, offset, s ) {
        return bind[parseInt(p1)-1];
    } );
  
    return sql;
}
function formatSQL( sql, bind ) {
    sql = sql.replace( /\$([1-9]+)/g, function( match, p1, offset, s ) {
        return db.escape( bind[parseInt(p1)-1] );
    } );
  
    return sql;
}

new cronJob( config.cron.spec, function() {
    debug( "Collecting..." );
    for( var j = 0; j < collections.length; j ++ ) {
        debug( "  Updating '" + collections[j].title + "'" );
        for( var k = 0; k < collections[j].collections.length; k++ ) {
            colspec = collections[j].collections[k];
            debug( "    Using set '" + colspec.set + "'" );
            if( colspec.presql ) {
                db.query( colspec.presql, function( err, res ) {
                    if( err ) { error( err ); }
                } );
            }
            red.smembers(
                colspec.set,
                ( function( coll, err, keys ) {
                    debug( "    Found " + keys.length + " keys" );
                    for( var ki = 0; ki < keys.length; ki ++ ) {
                        red.get(
                            keys[ki],
                            ( function( key, coll, err, val ) {
                                if( match = new RegExp( coll.pattern ).exec( key ) ) {
                                    str = formatSQL( coll.sql, [val].concat(match.slice(1)) );                 
                                    debug( str );
                                    db.query( str, function( err, res ) {
                                        if( err ) {
                                            // don't die!
                                            console.error( err );
                                        } else {
                                            // nothing :)
                                        }
                                    } );
                                }
                            } ).bind( null, keys[ki], coll )
                        );
                        if( true == coll.reset ) {
                            debug( "    Clearing " + keys[ki] );
                            red.del( keys[ki] );
                        }
                    }
                } ).bind( null, colspec )
            );
            red.del( colspec.set );
            if( colspec.postsql ) {
                db.query( colspec.postsql, function( err, res ) {
                    if( err ) { error( err ); }
                } );
            }
        }
    }
}, null, true, 'Europe/London' );
     
http.createServer(function(request, response) {
    //var date = new Date;
    //var day = date.getUTCFullYear() + "-" + (date.getUTCMonth() + 1) + "-" + date.getUTCDate();
    
    ua = request.headers[ "user-agent" ];
    //debug( ua );
    if( ua ) {
        if( bladerunner.validate( { "client_useragent": ua } ) ) {
            //debug( "validates" );
            action_spec = request.url.slice(1).split("?")[0];
            if( action_spec ) {
                actions = action_spec.split(",");
                for( var i = 0; i < actions.length; i++ ) {
                    // increment count in redis
                    //console.log( actions[i] );
                    for( var j = 0; j < collections.length; j ++ ) {
                        if( match = new RegExp( collections[j].pattern ).exec( actions[i] ) ) {
                            if( collections[j].keys ) {
                                for( k = 0; k < collections[j].keys.length; k ++ ) {
                                    var key = moment().format(
                                        format(
                                            collections[j].keys[k].format,
                                            match.slice(1)
                                        )
                                    );
                                    //debug( "Matched - increment " + key );
                                    red.incr( key );
                                    // put this key in a redis 'dirty' set
                                    red.sadd( collections[j].keys[k].set, key );
                                }
                            }
                        }
                    }
                }
            }
        } else {
            //debug( "robot rock" );
        }
    }

    response.writeHead(200, { "Content-Type": "image/gif" });
    response.write( transpalan, "binary" );        
    response.end();
} ).listen( config.server.port, config.server.host );

console.log( "Listening on " + config.server.host + ":" + config.server.port + "." );
