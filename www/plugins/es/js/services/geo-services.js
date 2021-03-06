angular.module('cesium.es.geo.services', ['cesium.services', 'cesium.es.http.services'])
  .config(function(PluginServiceProvider, csConfig) {
    'ngInject';

    var enable = csConfig.plugins && csConfig.plugins.es;
    if (enable) {
      // Will force to load this service
      PluginServiceProvider.registerEagerLoadingService('esGeo');
    }

  })

  .factory('esGeo', function($rootScope, $q, csConfig, csSettings, csHttp) {
    'ngInject';

    var
      that = this;

    that.raw = {
      osm: {
        search: csHttp.get('nominatim.openstreetmap.org', 443, '/search.php?format=json')
      },
      google: {
        apiKey: undefined,
        search: csHttp.get('maps.google.com', 443, '/maps/api/geocode/json')
      },
      searchByIP: csHttp.get('freegeoip.net', 443, '/json/:ip')
    };

    function googleSearchPositionByString(address) {

      return that.raw.google.search({address: address, key: that.raw.google.apiKey})
        .then(function(res) {
          if (!res || !res.results || !res.results.length) return;
          return res.results.reduce(function(res, hit) {
            return res.concat({
              display_name: hit.address_components && hit.address_components.reduce(function(res, address){
                return address.long_name ? res.concat(address.long_name) : res;
              }, []).join(', '),
              lat: hit.geometry && hit.geometry.location && hit.geometry.location.lat,
              lon: hit.geometry && hit.geometry.location && hit.geometry.location.lng
            });
          }, []);
        });
    }

    function _fallbackSearchPositionByString(osmErr, address) {

      console.debug('[ES] [geo] Search position failed on [OSM]. Trying [google] service');

      return googleSearchPositionByString(address)
        .catch(function(googleErr) {
          console.debug('[ES] [geo] Search position failed on [google] service');
          throw osmErr || googleErr; // throw first OMS error if exists
        });
    }

    function searchPositionByAddress(query) {

      if (typeof query == 'string') {
        query = {q: query};
      }

      var now = new Date();
      //console.debug('[ES] [geo] Searching position...', query);

      return that.raw.osm.search(query)
        .then(function(res) {
          console.debug('[ES] [geo] Found {0} address position(s) in {0}ms'.format(res && res.length || 0, new Date().getTime() - now.getTime()), res);
          return res;
        })

        // Fallback service
        .catch(function(err) {
          var address = query.q ? query.q : ((query.street ? query.street +', ' : '') + query.city +  (query.country ? ', '+ query.country : ''));
          return _fallbackSearchPositionByString(err, address);
        });
    }

    function getCurrentPosition() {
      var defer = $q.defer();
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(function(position) {
          if (!position || !position.coords) {
            console.error('[ES] [geo] navigator geolocation > Unknown format:', position);
            return;
          }
          defer.resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude
          });
        }, function(error) {
          defer.reject(error);
        },{timeout:5000});
      }else{
        defer.reject();
      }
      return defer.promise;
    }

    function searchPositionByIP(ip) {

      //var now = new Date();
      //console.debug('[ES] [geo] Searching IP position [{0}]...'.format(ip));

      return that.raw.searchByIP({ip: ip})
        .then(function(res) {
          //console.debug('[ES] [geo] Found IP {0} position in {0}ms'.format(res ? 1 : 0, new Date().getTime() - now.getTime()));
          return res ? {lat: res.latitude,lng: res.longitude} : undefined;
        });
    }

    that.raw.google.apiKey = csConfig.plugins && csConfig.plugins.es && csConfig.plugins.es.googleApiKey;
    var hasConfigApiKey = !!that.raw.google.apiKey;
    csSettings.ready()
      .then(function() {

        // Listen settings changed
        function onSettingsChanged(data){
          if (!hasConfigApiKey) {
            // If no google api key in config, use in settings
            that.raw.google.apiKey = data.plugins.es.googleApiKey;
          }
          that.raw.google.enable = that.raw.google.apiKey && data.plugins && data.plugins.es && data.plugins.es.enableGoogleApi;
        }
        csSettings.api.data.on.changed($rootScope, onSettingsChanged, this);

        onSettingsChanged(csSettings.data);
      });

    return {
      point: {
        current: getCurrentPosition,
        searchByAddress: searchPositionByAddress,
        searchByIP: searchPositionByIP
      },
      google: {
        isEnable: function() {
          return that.raw.google.enable && that.raw.google.apiKey;
        },
        searchByAddress: googleSearchPositionByString
      }
    };
  });
