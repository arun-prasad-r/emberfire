import Mixin from '@ember/object/mixin';
import { subscribe, unsubscribe } from '../services/realtime-listener';
import DS from 'ember-data';

// TODO make sure realtime works on findAll
//      handle includes
export default Mixin.create({
    
    subscribeModel(model:any) {
        let subscriptionId = model.toString();
        subscribe(this, model, subscriptionId);
    },
    unsubscribeModel(model: any) {
        let subscriptionId = model.toString()
        unsubscribe(this, subscriptionId);
    },

    afterModel(model: any) {
        if (model instanceof (DS.Model) || model instanceof (DS.RecordArray)) {
            this.subscribeModel(model);
        } else {
            let keys = Object.keys(model);
            keys.forEach((key) => {
                let individualModel = model[key] as any;
                if (individualModel instanceof (DS.Model) || individualModel instanceof (DS.RecordArray)) {
                    this.subscribeModel(model[key]);
                }
            });
        }
        return this._super(model);
    },

    deactivate() {
        // @ts-ignore.
        let model = this.currentModel;
        if (model instanceof (DS.Model) || model instanceof (DS.RecordArray)) {
            this.unsubscribeModel(model);
        } else {
            let keys = Object.keys(model);
            keys.forEach((key) => {
                let individualModel = model[key];
                if (individualModel instanceof (DS.Model) || individualModel instanceof (DS.RecordArray)) {
                    this.unsubscribeModel(individualModel);
                }
            });
        }
        return this._super();
    }
});