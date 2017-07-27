
angular.module('cesium.map.network.controllers', ['cesium.services', 'cesium.map.services'])

  .config(function($stateProvider, PluginServiceProvider, csConfig) {
    'ngInject';

    var enable = csConfig.plugins && csConfig.plugins.es;
    if (enable) {

      PluginServiceProvider

      // Extension de la vue d'une identité: ajout d'un bouton
        .extendState('app.network', {
          points: {
            'filter-buttons': {
              templateUrl: "plugins/map/templates/network/lookup_extend.html"
            }
          }
        });

      // [NEW] Ajout d'une nouvelle page #/app/wot/map
      $stateProvider
        .state('app.view_network_map', {
          url: "/network/map?lat&lng&zoom",
          views: {
            'menuContent': {
              templateUrl: "plugins/map/templates/network/view_map.html",
              controller: 'MapNetworkViewCtrl'
            }
          }
        });
    }

    L.AwesomeMarkers.Icon.prototype.options.prefix = 'ion';
  })

  // [NEW] Manage events from the page #/app/wot/map
  .controller('MapNetworkViewCtrl', function($scope, $controller, $q, $interpolate, $translate, $state, $filter, $templateCache, $timeout, $ionicHistory,
                                         esGeo, UIUtils, csNetwork, MapUtils, leafletData) {
    'ngInject';

    // Initialize the super class and extend it.
    angular.extend(this, $controller('NetworkLookupCtrl', {$scope: $scope}));

    var
      formatPubkey = $filter('formatPubkey'),
      markerMessageTemplate,
      // Create a  hidden layer, to hold search markers
      searchLayer = L.layerGroup({visible: false}),
      loadingControl,
      icons= {
        member: {
          type: 'awesomeMarker',
          icon: 'person',
          markerColor: 'green'
        },
        mirror: {
          type: 'awesomeMarker',
          icon: 'android-desktop',
          markerColor: 'green'
        },
        offline: {
          type: 'awesomeMarker',
          icon: 'ion-close-circled',
          markerColor: 'red'
        }
      },
      markerIdByPeerId = {},
      markerCounter = 0
    ;

    // Init the template for marker popup
    markerMessageTemplate = '<div class="item item-peer item-icon-left no-border" ng-click="selectPeer(peer)">';
    markerMessageTemplate += $templateCache.get('templates/network/item_content_peer.html');
    markerMessageTemplate += '</div>';
    markerMessageTemplate = markerMessageTemplate.replace(/[:]rebind[:]|[:][:]/g, ''); // remove binding limitation

    $scope.mapId = 'map-network-' + $scope.$id;
    $scope.helptipPrefix = 'helptip-' + $scope.mapId; // make to override, to avoid error during help tour

    $scope.map = MapUtils.map({
        layers: {
          overlays: {
            member: {
              type: 'group',
              name: 'MAP.NETWORK.VIEW.LAYER.MEMBER',
              visible: true
            },
            mirror: {
              type: 'group',
              name: 'MAP.NETWORK.VIEW.LAYER.MIRROR',
              visible: true
            },
            offline: {
              type: 'group',
              name: 'MAP.NETWORK.VIEW.LAYER.OFFLINE',
              visible: false
            }
          }
        },
        markers: {}
      });

    var inheritedEnter = $scope.enter;
    $scope.enter = function(e, state) {
      if ($scope.networkStarted) return;

      // remember state, to be able to refresh location
      $scope.stateName = state && state.stateName;
      $scope.stateParams = angular.copy(state && state.stateParams||{});

      // Read center from state params
      $scope.stateCenter = MapUtils.center(state.stateParams);

      // inherited
      return inheritedEnter(e, state);
    };
    $scope.$on('$ionicView.enter', $scope.enter);

    // Update the browser location, to be able to refresh the page
    $scope.updateLocation = function() {

      $ionicHistory.nextViewOptions({
        disableAnimate: true,
        disableBack: true,
        historyRoot: false
      });

      $scope.stateParams = $scope.stateParams || {};
      $scope.stateParams.lat = ($scope.map.center.lat != MapUtils.constants.DEFAULT_CENTER.lat) ? $scope.map.center.lat : undefined;
      $scope.stateParams.lng = ($scope.map.center.lng != MapUtils.constants.DEFAULT_CENTER.lng) ? $scope.map.center.lng : undefined;
      $scope.stateParams.zoom = ($scope.map.center.zoom != MapUtils.constants.DEFAULT_CENTER.zoom) ? $scope.map.center.zoom : undefined;

      $state.go($scope.stateName, $scope.stateParams, {
        reload: false,
        inherit: true,
        notify: false}
      );
    };


    // removeIf(device)
    $scope.onMapCenterChanged = function() {
      if (!$scope.loading) {
        $timeout($scope.updateLocation, 500);
      }
    };
    $scope.$watch('map.center', $scope.onMapCenterChanged, true);
    // endRemoveIf(device)

    $scope.showHelpTip = function() {
      // override subclass
    };

    $scope.updateView = function(data) {
      console.debug("[map] [peers] Updating UI");

      $scope.search.results = data.peers;
      $scope.search.memberPeersCount = data.memberPeersCount;
      // Always tru if network not started (e.g. after leave+renter the view)
      $scope.search.loading = !$scope.networkStarted || csNetwork.isBusy();

      if (!$scope.search.results || !$scope.search.results.length) return; // nothing

      var markerIdByPeerIdToRemove = angular.copy(markerIdByPeerId);
      var lngStep = 0.001;

      var updateMarker = function(marker, peer) {
        marker.layer = !peer.online ? 'offline' : (peer.uid ? 'member' : 'mirror');
        marker.icon = angular.copy(icons[marker.layer]);
        marker.opacity = peer.online ? 0.9 : 0.7;
        marker.title = peer.dns || peer.server;
        if (peer.online && !peer.hasMainConsensusBlock) {
          marker.icon.markerColor = peer.hasConsensusBlock ? 'beige' : 'lightgray';
        }
        if (!marker.lng) {
          marker.lng = marker.position.lng + Math.random() / 1000;
          marker.lat = marker.position.lat + Math.random() / 1000;
        }

        return marker;
      };

      _.forEach(data.peers, function(peer){
        // skip TOR peer
        if (peer.isTor()) return; // already define
        // get marker id
        var markerId = markerIdByPeerId[peer.id];

        // if already exists
        if (markerId && $scope.map.markers[markerId]) {
          updateMarker($scope.map.markers[markerId], peer);
          delete markerIdByPeerIdToRemove[peer.id];
          return;
        }

        // Get position by IP
        var ip = peer.getHost();
        esGeo.point.searchByIP(ip)

          // Create the marker
          .then(function(position){
            var marker = updateMarker({
              position: position,
              getMessageScope: function() {
                var scope = $scope.$new();
                scope.peer = peer;
                return scope;
              },
              draggable: true,
              focus: false,
              message: markerMessageTemplate
            }, peer);

            // Add marker to list
            markerId = '' + markerCounter++;
            $scope.map.markers[markerId] = marker;
            markerIdByPeerId[peer.id] = markerId;
          })
          .catch(function(err) {
            console.debug('No position found for IP ['+ip+']', err);
          });
      });

      // Remove old markers not found in the new result
      _.forEach(_.keys(markerIdByPeerIdToRemove), function(peerId) {
        delete markerIdByPeerId[peerId];
      });
      _.forEach(_.values(markerIdByPeerIdToRemove), function(markerId) {
        delete $scope.map.markers[markerId];
      });

      leafletData.getMap($scope.mapId).then(function(map) {

        // Add loading control
        if (!loadingControl) {
          loadingControl = L.Control.loading({
            separate: true
          }).addTo(map);
          if ($scope.search.loading) {
            map.fire('dataloading');
          }
        }

        else if (!$scope.search.loading) {
          $timeout(function() {
            map.fire('dataload');
          }, 1000);
        }

        // Recenter map// Update map center (if need)
        var needCenterUpdate = $scope.stateCenter && !angular.equals($scope.map.center, $scope.stateCenter);
        if (needCenterUpdate) {
          MapUtils.updateCenter(map, $scope.stateCenter);
          delete $scope.stateCenter;
        }
      });
    };

  });
