'use strict';

/*
 * Copyright 2014 Next Century Corporation
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

/**
 * This directive adds a barchart to the DOM and drives the visualization data from
 * whatever database and table are currently selected in neon.  This directive accomplishes that
 * by using getting a neon connection from a connection service and listening for
 * neon system events (e.g., data tables changed).  On these events, it requeries the active
 * connection for data and updates applies the change to its scope.  The contained
 * barchart will update as a result.
 * @namespace neonDemo.directives
 * @class barchart
 * @constructor
 */
angular.module('neonDemo.directives')
.directive('barchart', ['external', 'ConnectionService', 'DatasetService', 'ErrorNotificationService', 'FilterService', 'ExportService', 'LinksPopupService', 'VisualizationService',
function(external, connectionService, datasetService, errorNotificationService, filterService, exportService, linksPopupService, visualizationService) {
    return {
        templateUrl: 'components/barChart/barChart.html',
        restrict: 'EA',
        scope: {
            bindTitle: '=',
            bindXAxisField: '=',
            bindYAxisField: '=',
            bindAggregation: '=',
            bindLimit: '=',
            bindFilterField: '=',
            bindFilterValue: '=',
            bindTable: '=',
            bindDatabase: '=',
            bindStateId: '=',
            hideHeader: '=?',
            hideAdvancedOptions: '=?',
            limitCount: '=?' // Deprecated
        },
        link: function($scope, $element) {
            $element.addClass('barchartDirective');

            $scope.element = $element;
            $scope.visualizationId = "barchart-" + uuid();

            $scope.databases = [];
            $scope.tables = [];
            $scope.fields = [];
            $scope.chart = undefined;
            $scope.filterKeys = {};
            $scope.filterSet = undefined;
            $scope.errorMessage = undefined;
            $scope.loadingData = false;
            $scope.outstandingQuery = undefined;
            $scope.linksPopupButtonIsDisabled = true;
            $scope.queryLimitCount = 0;

            $scope.options = {
                database: {},
                table: {},
                attrX: "",
                attrY: "",
                barType: $scope.bindAggregation || "count",
                limitCount: $scope.bindLimit || 100,
                filterField: {}
            };

            var COUNT_FIELD_NAME = 'Count';

            // Functions for the options-menu directive.
            $scope.optionsMenuButtonText = function() {
                if($scope.queryLimitCount > 0) {
                    return "Limited to " + $scope.queryLimitCount + " Bars";
                }
                return "";
            };
            $scope.showOptionsMenuButtonText = function() {
                return $scope.queryLimitCount > 0;
            };

            var updateChartSize = function() {
                // Set the width of the title to the width of the visualization minus the width of the chart options button/text and padding.
                var titleWidth = $element.width() - $element.find(".chart-options").outerWidth(true) - 20;
                $element.find(".title").css("maxWidth", titleWidth);

                if($scope.chart) {
                    var headerHeight = 0;
                    $element.find(".header-container").each(function() {
                        headerHeight += $(this).outerHeight(true);
                    });
                    $element.find('.barchart').height($element.height() - headerHeight);

                    $scope.chart.draw();
                }
            };

            var initialize = function() {
                drawBlankChart();

                $scope.messenger.events({
                    filtersChanged: onFiltersChanged
                });
                $scope.messenger.subscribe(datasetService.UPDATE_DATA_CHANNEL, function() {
                    queryForData(false);
                });

                $scope.exportID = exportService.register($scope.makeBarchartExportObject);
                visualizationService.register($scope.bindStateId, bindFields);

                $scope.$on('$destroy', function() {
                    XDATA.userALE.log({
                        activity: "remove",
                        action: "remove",
                        elementId: "barchart",
                        elementType: "canvas",
                        elementGroup: "chart_group",
                        source: "system",
                        tags: ["remove", "barchart"]
                    });
                    linksPopupService.deleteLinks($scope.visualizationId);
                    $element.off("resize", updateChartSize);
                    $element.find(".chart-options a").off("resize", updateChartSize);
                    $scope.messenger.unsubscribeAll();
                    // Remove our filter if we had an active one.
                    if($scope.filterSet) {
                        filterService.removeFilter($scope.options.database.name, $scope.options.table.name, [$scope.options.attrX.columnName]);
                    }
                    exportService.unregister($scope.exportID);
                    visualizationService.unregister($scope.bindStateId);
                });

                $scope.$watch('options.attrX', function(newValue) {
                    logChange('attrX', newValue);
                    if(!$scope.loadingData && $scope.options.database.name && $scope.options.table.name) {
                        queryForData(true);
                    }
                });

                $scope.$watch('options.attrY', function(newValue) {
                    logChange('attrY', newValue);
                    if(!$scope.loadingData && $scope.options.database.name && $scope.options.table.name) {
                        queryForData(true);
                    }
                });

                $scope.$watch('options.barType', function(newValue) {
                    logChange('aggregation', newValue);
                    if(!$scope.loadingData && $scope.options.database.name && $scope.options.table.name) {
                        queryForData(false);
                    }
                });

                // This resizes the chart when the div changes.  This rely's on jquery's resize plugin to fire
                // on the associated element and not just the window.
                $element.resize(updateChartSize);
                $element.find(".chart-options a").resize(updateChartSize);
            };

            var logChange = function(field, newValue, type) {
                var source = "user";
                var action = "click";

                // Override the default action if a field changes while loading data during
                // intialization or a dataset change.
                if($scope.loadingData) {
                    source = "system";
                    action = "reset";
                }

                XDATA.userALE.log({
                    activity: "select",
                    action: action,
                    elementId: "barchart",
                    elementType: type || "combobox",
                    elementSub: "barchart-" + field,
                    elementGroup: "chart_group",
                    source: source,
                    tags: ["options", "barchart", newValue]
                });
            };

            $scope.handleChangeUnsharedFilterField = function() {
                logChange("unshared-filter-field", $scope.options.filterField.columnName);
                $scope.options.filterValue = "";
            };

            $scope.handleChangeUnsharedFilterValue = function() {
                logChange("unshared-filter-value", $scope.options.filterValue);
                if(!$scope.loadingData) {
                    queryForData(true);
                }
            };

            $scope.handleRemoveUnsharedFilter = function() {
                logChange("unshared-filter", "", "button");
                $scope.options.filterValue = "";
                if(!$scope.loadingData) {
                    queryForData(true);
                }
            };

            $scope.handleChangeLimit = function() {
                logChange("limit", $scope.options.limitCount);
                if(!$scope.loadingData && $scope.options.database.name && $scope.options.table.name) {
                    queryForData(true);
                }
            };

            /**
             * Event handler for filter changed events issued over Neon's messaging channels.
             * @param {Object} message A Neon filter changed message.
             * @method onFiltersChanged
             * @private
             */
            var onFiltersChanged = function(message) {
                if(message.addedFilter && message.addedFilter.databaseName === $scope.options.database.name && message.addedFilter.tableName === $scope.options.table.name) {
                    XDATA.userALE.log({
                        activity: "alter",
                        action: "query",
                        elementId: "barchart",
                        elementType: "canvas",
                        elementSub: "barchart",
                        elementGroup: "chart_group",
                        source: "system",
                        tags: ["filter-change", "barchart"]
                    });

                    updateFilterSet();
                    queryForData(false);
                }
            };

            /*
             * Updates the filter set with any matching filters found.
             * @method updateFilterSet
             * @private
             */
            var updateFilterSet = function() {
                if(datasetService.isFieldValid($scope.options.attrX)) {
                    var filter = filterService.getFilter($scope.options.database.name, $scope.options.table.name, [$scope.options.attrX.columnName]);

                    if(filter && filterService.hasSingleClause(filter)) {
                        $scope.filterSet = {
                            key: filter.filter.whereClause.lhs,
                            value: filter.filter.whereClause.rhs,
                            database: $scope.options.database.name,
                            table: $scope.options.table.name
                        };
                    } else if(!filter && $scope.filterSet) {
                        $scope.chart.clearSelectedBar();
                        clearFilterSet();
                    }
                }
            };

            /**
             * Displays data for any currently active datasets.
             * @method displayActiveDataset
             * @private
             */
            var displayActiveDataset = function() {
                if(!datasetService.hasDataset() || $scope.loadingData) {
                    return;
                }

                $scope.databases = datasetService.getDatabases();
                $scope.options.database = $scope.databases[0];
                if($scope.bindDatabase) {
                    for(var i = 0; i < $scope.databases.length; ++i) {
                        if($scope.bindDatabase === $scope.databases[i].name) {
                            $scope.options.database = $scope.databases[i];
                            break;
                        }
                    }
                }
                $scope.updateTables(function() {
                    if($scope.options.database && $scope.options.database.name && $scope.options.table && $scope.options.table.name) {
                        updateFilterSet();
                    }
                    queryForData(true);
                });
            };

            $scope.updateTables = function(callback) {
                $scope.tables = datasetService.getTables($scope.options.database.name);
                $scope.options.table = datasetService.getFirstTableWithMappings($scope.options.database.name, [neonMappings.BAR_GROUPS, neonMappings.Y_AXIS]) || $scope.tables[0];
                if($scope.bindTable) {
                    for(var i = 0; i < $scope.tables.length; ++i) {
                        if($scope.bindTable === $scope.tables[i].name) {
                            $scope.options.table = $scope.tables[i];
                            break;
                        }
                    }
                }
                $scope.updateFields(callback);
            };

            $scope.updateFields = function(callback) {
                $scope.loadingData = true;
                $scope.fields = datasetService.getSortedFields($scope.options.database.name, $scope.options.table.name);

                var attrX = $scope.bindXAxisField || datasetService.getMapping($scope.options.database.name, $scope.options.table.name, neonMappings.BAR_GROUPS) || "";
                $scope.options.attrX = _.find($scope.fields, function(field) {
                    return field.columnName === attrX;
                }) || datasetService.createBlankField();
                var attrY = $scope.bindYAxisField || datasetService.getMapping($scope.options.database.name, $scope.options.table.name, neonMappings.Y_AXIS) || "";
                $scope.options.attrY = _.find($scope.fields, function(field) {
                    return field.columnName === attrY;
                }) || datasetService.createBlankField();
                var filterFieldName = $scope.bindFilterField || "";
                $scope.options.filterField = _.find($scope.fields, function(field) {
                    return field.columnName === filterFieldName;
                }) || datasetService.createBlankField();
                $scope.options.filterValue = $scope.bindFilterValue || "";

                if($scope.filterSet) {
                    $scope.clearFilterSet();
                } else if(callback) {
                    callback();
                    return;
                }
                queryForData(true);
            };

            var buildQuery = function() {
                var whereNotNull = neon.query.where($scope.options.attrX.columnName, '!=', null);
                var query = new neon.query.Query().selectFrom($scope.options.database.name, $scope.options.table.name).groupBy($scope.options.attrX).where(whereNotNull);

                if($scope.filterSet && $scope.filterSet.key && $scope.filterSet.value) {
                    var filterClause = createFilterClauseForXAxis({
                                database: $scope.options.database.name,
                                table: $scope.options.table.name
                            }, $scope.options.attrX.columnName);
                    query.ignoreFilters([filterService.getFilterKey($scope.options.database.name, $scope.options.table.name, filterClause)]);
                }

                var queryType;
                if($scope.options.barType === 'count') {
                    queryType = neon.query.COUNT;
                } else if($scope.options.barType === 'sum') {
                    queryType = neon.query.SUM;
                } else if($scope.options.barType === 'average') {
                    queryType = neon.query.AVG;
                }

                if($scope.options.barType === "count") {
                    query.aggregate(queryType, '*', COUNT_FIELD_NAME);
                } else {
                    query.aggregate(queryType, $scope.options.attrY.columnName, COUNT_FIELD_NAME);
                }

                if(datasetService.isFieldValid($scope.options.filterField) && $scope.options.filterValue) {
                    var operator = "contains";
                    var value = $scope.options.filterValue;
                    if($.isNumeric(value)) {
                        operator = "=";
                        value = parseFloat(value);
                    }
                    query.where(neon.query.and(whereNotNull, neon.query.where($scope.options.filterField.columnName, operator, value)));
                }

                query.sortBy(COUNT_FIELD_NAME, neon.query.DESCENDING);
                query.limit($scope.options.limitCount);
                return query;
            };

            var queryForData = function(rebuildChart) {
                if($scope.errorMessage) {
                    errorNotificationService.hideErrorMessage($scope.errorMessage);
                    $scope.errorMessage = undefined;
                }

                // Save the title during the query so the title doesn't change immediately if the user changes the unshared filter.
                $scope.queryTitle = $scope.generateTitle(true);

                var connection = connectionService.getActiveConnection();

                if(!connection || !datasetService.isFieldValid($scope.options.attrX) || (!$scope.options.attrY.columnName && $scope.options.barType !== "count")) {
                    drawBlankChart();
                    $scope.loadingData = false;
                    return;
                }

                var query = buildQuery();

                XDATA.userALE.log({
                    activity: "alter",
                    action: "query",
                    elementId: "barchart",
                    elementType: "canvas",
                    elementSub: "barchart",
                    elementGroup: "chart_group",
                    source: "system",
                    tags: ["query", "barchart"]
                });

                if($scope.outstandingQuery) {
                    $scope.outstandingQuery.abort();
                }

                $scope.outstandingQuery = connection.executeQuery(query);
                $scope.outstandingQuery.always(function() {
                    $scope.outstandingQuery = undefined;
                });
                $scope.outstandingQuery.done(function(queryResults) {
                    $scope.$apply(function() {
                        XDATA.userALE.log({
                            activity: "alter",
                            action: "receive",
                            elementId: "barchart",
                            elementType: "canvas",
                            elementSub: "barchart",
                            elementGroup: "chart_group",
                            source: "system",
                            tags: ["receive", "barchart"]
                        });
                        doDrawChart(queryResults, rebuildChart);
                        $scope.loadingData = false;
                        XDATA.userALE.log({
                            activity: "alter",
                            action: "render",
                            elementId: "barchart",
                            elementType: "canvas",
                            elementSub: "barchart",
                            elementGroup: "chart_group",
                            source: "system",
                            tags: ["render", "barchart"]
                        });
                    });
                });
                $scope.outstandingQuery.fail(function(response) {
                    $scope.outstandingQuery = undefined;
                    if(response.status === 0) {
                        XDATA.userALE.log({
                            activity: "alter",
                            action: "canceled",
                            elementId: "barchart",
                            elementType: "canvas",
                            elementSub: "barchart",
                            elementGroup: "chart_group",
                            source: "system",
                            tags: ["canceled", "barchart"]
                        });
                    } else {
                        XDATA.userALE.log({
                            activity: "alter",
                            action: "failed",
                            elementId: "barchart",
                            elementType: "canvas",
                            elementSub: "barchart",
                            elementGroup: "chart_group",
                            source: "system",
                            tags: ["failed", "barchart"]
                        });
                        drawBlankChart();
                        $scope.loadingData = false;
                        if(response.responseJSON) {
                            $scope.errorMessage = errorNotificationService.showErrorMessage($element, response.responseJSON.error, response.responseJSON.stackTrace);
                        }
                    }
                });
            };

            var drawBlankChart = function() {
                doDrawChart({
                    data: []
                }, true);
            };

            var clickFilterHandler = function(value) {
                if(!$scope.options.attrX.columnName) {
                    return;
                }

                handleFilterSet($scope.options.attrX.columnName, value);

                // Store the value for the filter to use during filter creation.
                $scope.filterValue = value;

                var connection = connectionService.getActiveConnection();
                if($scope.messenger && connection) {
                    var filterNameObj = {
                        visName: "BarChart",
                        text: $scope.filterSet.key + " = " + $scope.filterSet.value
                    };
                    filterService.addFilter($scope.messenger, $scope.options.database.name, $scope.options.table.name,
                        [$scope.options.attrX.columnName], createFilterClauseForXAxis, filterNameObj);
                }
            };

            /**
             * Creates and returns a filter on the given x-axis field using the value set by this visualization.
             * @param {Object} databaseAndTableName Contains the database and table name
             * @param {String} xAxisFieldName The name of the x-axis field on which to filter
             * @method createFilterClauseForXAxis
             * @private
             * @return {Object} A neon.query.Filter object
             */
            var createFilterClauseForXAxis = function(databaseAndTableName, xAxisFieldName) {
                return neon.query.where(xAxisFieldName, '=', $scope.filterValue);
            };

            var handleFilterSet = function(field, value) {
                $scope.filterSet = {
                    key: field,
                    value: value,
                    database: $scope.options.database.name,
                    table: $scope.options.table.name
                };

                var mappings = datasetService.getMappings($scope.options.database.name, $scope.options.table.name);
                var chartLinks = {};

                var key = linksPopupService.generateKey($scope.options.attrX, value);
                chartLinks[key] = linksPopupService.createAllServiceLinkObjects(external.services, mappings, field, value);

                linksPopupService.setLinks($scope.visualizationId, chartLinks);
                $scope.linksPopupButtonIsDisabled = !chartLinks[key].length;

                //no need to requery because barchart ignores its own filter
            };

            var clearFilterSet = function() {
                $scope.filterSet = undefined;
                linksPopupService.deleteLinks($scope.visualizationId);
            };

            $scope.clearFilterSet = function() {
                if($scope.filterSet) {
                    XDATA.userALE.log({
                        activity: "deselect",
                        action: "click",
                        elementId: "barchart",
                        elementType: "button",
                        elementGroup: "chart_group",
                        source: "user",
                        tags: ["filter", "barchart"]
                    });
                    filterService.removeFilter($scope.filterSet.database, $scope.filterSet.table, [$scope.filterSet.key], function() {
                        $scope.chart.clearSelectedBar();
                        clearFilterSet();
                    });
                }
            };

            var doDrawChart = function(data, destroy) {
                var opts = {
                    data: data.data,
                    x: $scope.options.attrX.columnName,
                    y: COUNT_FIELD_NAME,
                    responsive: false,
                    clickHandler: clickFilterHandler
                };

                if($scope.filterSet && $scope.filterSet.value) {
                    opts.selectedKey = $scope.filterSet.value;
                }

                // Destroy the old chart and rebuild it.
                if($scope.chart && destroy) {
                    $scope.chart.destroy();
                    $scope.chart = new charts.BarChart($element[0], '.barchart', opts);
                } else if($scope.chart) {
                    $scope.chart.setOptsConfiguration(opts);
                } else {
                    $scope.chart = new charts.BarChart($element[0], '.barchart', opts);
                }

                updateChartSize();

                // Save the limit count for the most recent query to show in the options menu button text.
                // Don't use the current limit count because that may be changed to a different number.
                $scope.queryLimitCount = data.data.length >= $scope.options.limitCount ? $scope.options.limitCount : 0;
            };

            $scope.getLegendText = function() {
                if($scope.options.barType === "average") {
                    return "Average " + $scope.options.attrY.prettyName + " vs. " + $scope.options.attrX.prettyName;
                }
                if($scope.options.barType === "sum") {
                    return "Sum " + $scope.options.attrY.prettyName + " vs. " + $scope.options.attrX.prettyName;
                }
                if($scope.options.barType === "count") {
                    return "Count of " + $scope.options.attrX.prettyName;
                }
                return "";
            };

            /**
             * Creates and returns an object that contains information needed to export the data in this widget.
             * @return {Object} An object containing all the information needed to export the data in this widget.
             */
            $scope.makeBarchartExportObject = function() {
                XDATA.userALE.log({
                    activity: "perform",
                    action: "click",
                    elementId: "barchart-export",
                    elementType: "button",
                    elementGroup: "chart_group",
                    source: "user",
                    tags: ["options", "barchart", "export"]
                });

                var capitalizeFirstLetter = function(str) {
                    var first = str[0].toUpperCase();
                    return first + str.slice(1);
                };

                var query = buildQuery();
                query.limitClause = exportService.getLimitClause();
                query.ignoreFilters_ = exportService.getIgnoreFilters();
                query.ignoredFilterIds_ = exportService.getIgnoredFilterIds();
                var finalObject = {
                    name: "Bar_Chart",
                    data: [{
                        query: query,
                        name: "barchart-" + $scope.exportID,
                        fields: [],
                        ignoreFilters: query.ignoreFilters_,
                        selectionOnly: query.selectionOnly_,
                        ignoredFilterIds: query.ignoredFilterIds_,
                        type: "query"
                    }]
                };
                finalObject.data[0].fields.push({
                    query: query.groupByClauses[0].field,
                    pretty: capitalizeFirstLetter(query.groupByClauses[0].field)
                });
                if($scope.options.barType === "average") {
                    finalObject.data[0].fields.push({
                        query: COUNT_FIELD_NAME,
                        pretty: "Average of " + query.aggregates[0].field
                    });
                }
                if($scope.options.barType === "sum") {
                    finalObject.data[0].fields.push({
                        query: COUNT_FIELD_NAME,
                        pretty: "Sum of " + query.aggregates[0].field
                    });
                }
                if($scope.options.barType === "count") {
                    finalObject.data[0].fields.push({
                        query: COUNT_FIELD_NAME,
                        pretty: "Count"
                    });
                }
                return finalObject;
            };

            /**
             * Creates and returns an object that contains all the binding fields needed to recreate the visualization's state.
             * @return {Object}
             * @method bindFields
             * @private
             */
            var bindFields = function() {
                var bindingFields = {};

                bindingFields["bind-title"] = $scope.bindTitle ? "'" + $scope.bindTitle + "'" : undefined;
                bindingFields["bind-x-axis-field"] = ($scope.options.attrX && $scope.options.attrX.columnName) ? "'" + $scope.options.attrX.columnName + "'" : undefined;
                bindingFields["bind-aggregation"] = $scope.options.barType ? "'" + $scope.options.barType + "'" : undefined;
                var hasYAxis = $scope.options.barType && $scope.options.barType !== 'count' && $scope.options.attrY && $scope.options.attrY.columnName;
                bindingFields["bind-y-axis-field"] = hasYAxis ? "'" + $scope.options.attrY.columnName + "'" : undefined;
                bindingFields["bind-table"] = ($scope.options.table && $scope.options.table.name) ? "'" + $scope.options.table.name + "'" : undefined;
                bindingFields["bind-database"] = ($scope.options.database && $scope.options.database.name) ? "'" + $scope.options.database.name + "'" : undefined;
                bindingFields["bind-limit"] = $scope.options.limitCount;
                bindingFields["bind-filter-field"] = ($scope.options.filterField && $scope.options.filterField.columnName) ? "'" + $scope.options.filterField.columnName + "'" : undefined;
                var hasFilterValue = $scope.options.filterField && $scope.options.filterField.columnName && $scope.options.filterValue;
                bindingFields["bind-filter-value"] = hasFilterValue ? "'" + $scope.options.filterValue + "'" : undefined;

                return bindingFields;
            };

            /**
             * Generates and returns the links popup key for this visualization.
             * @method generateLinksPopupKey
             * @return {String}
             */
            $scope.generateLinksPopupKey = function(value) {
                return linksPopupService.generateKey($scope.options.attrX, value);
            };

            /**
             * Generates and returns the title for this visualization.
             * @param {Boolean} resetQueryTitle
             * @method generateTitle
             * @return {String}
             */
            $scope.generateTitle = function(resetQueryTitle) {
                if(resetQueryTitle) {
                    $scope.queryTitle = "";
                }
                if($scope.queryTitle) {
                    return $scope.queryTitle;
                }
                var title = $scope.options.filterValue ? $scope.options.filterValue + " " : "";
                if($scope.bindTitle) {
                    return title + $scope.bindTitle;
                }
                if(_.keys($scope.options).length) {
                    return title + $scope.options.table.prettyName + ($scope.options.attrX.prettyName ? " / " + $scope.options.attrX.prettyName : "");
                }
                return title;
            };

            neon.ready(function() {
                $scope.messenger = new neon.eventing.Messenger();
                initialize();
                displayActiveDataset();
            });
        }
    };
}]);