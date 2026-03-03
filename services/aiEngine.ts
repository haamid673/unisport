// services/aiEngine.ts

import {
  SlotDemandPrediction,
  AIRecommendation,
  RevenueInsight,
  Facility
} from "../types";

/* ====================================================
   PREDICTIVE INTELLIGENCE ENGINE v1.1
   Adaptive Heuristic Model
   Deterministic but reacts to booking density
==================================================== */

export const aiEngine = {

  /* ====================================================
     SLOT DEMAND PREDICTION (Adaptive)
  ===================================================== */
  async analyzeSlotDemand(
    facilityName: string,
    sport: string,
    slots: { id: string; time: string; basePrice: number }[],
    history: { slotId: string }[]   // booking history passed in
  ): Promise<SlotDemandPrediction[]> {

    return slots.map(slot => {

      const bookingsForSlot =
        history.filter(h => h.slotId === slot.id).length;

      const occupancyScore = bookingsForSlot;

      const hour = parseInt(slot.time.split(":")[0]);

      const isPrimeHour = hour >= 17 && hour <= 21;

      let demandLevel: "Low" | "Normal" | "High";
      let multiplier = 1;
      let reasoning = "Standard demand window.";

      if (occupancyScore >= 5 || isPrimeHour) {
        demandLevel = "High";
        multiplier = 1.25;
        reasoning =
          "High booking density and peak timing indicate surge demand.";
      } else if (occupancyScore >= 2) {
        demandLevel = "Normal";
        multiplier = 1.1;
        reasoning =
          "Moderate demand observed from recent booking activity.";
      } else {
        demandLevel = "Low";
        multiplier = 0.95;
        reasoning =
          "Low occupancy detected. Promotional pricing suggested.";
      }

      return {
        slotId: slot.id,
        demandLevel,
        isSurge: demandLevel === "High",
        suggestedPrice: Math.round(slot.basePrice * multiplier),
        reasoning
      };
    });
  },

  /* ====================================================
     FACILITY RECOMMENDATIONS
  ===================================================== */
  async recommendFacilities(
    userPreferences: string[],
    bookedFacilityNames: string[],
    facilities: Facility[]
  ): Promise<AIRecommendation[]> {

    return facilities
      .filter(f => !bookedFacilityNames.includes(f.name))
      .slice(0, 3)
      .map(f => {

        const preferenceMatch =
          userPreferences.includes(f.sport);

        return {
          facilityId: f.id,
          reasoning: preferenceMatch
            ? "Matches your playing history and preferred sport."
            : "Trending among similar skill-level players.",
          confidence: preferenceMatch ? "High" : "Medium"
        };
      });
  },

  /* ====================================================
     REVENUE OPTIMIZATION (Adaptive)
  ===================================================== */
  async optimizeRevenue(
    facilityName: string,
    revenueData: {
      slotTime: string;
      revenue: number;
      occupancyRate: number;
    }[]
  ): Promise<RevenueInsight[]> {

    return revenueData.map(data => {

      let performance: "High Performing" | "Underperforming" | "Stable";
      let suggestedAction: string;
      let projectedRevenueImpact: number;

      if (data.occupancyRate > 75) {
        performance = "High Performing";
        suggestedAction =
          "Increase pricing by 5–8% during peak demand.";
        projectedRevenueImpact = 10;
      } else if (data.occupancyRate < 35) {
        performance = "Underperforming";
        suggestedAction =
          "Introduce targeted promotions to boost utilization.";
        projectedRevenueImpact = 15;
      } else {
        performance = "Stable";
        suggestedAction =
          "Maintain pricing. Monitor weekly booking patterns.";
        projectedRevenueImpact = 4;
      }

      return {
        slotId: data.slotTime,
        performance,
        suggestedAction,
        projectedRevenueImpact
      };
    });
  }
};