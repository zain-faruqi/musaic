import React from 'react'
import './styles.css'

export default function Shelf(props) {


    if (!props.items) {
        return (
            <div className='component-container'>
                <div className='shelf-title'>/ Favorites</div>
                <div className='shelf-container'>
                    <div className='shelf-items'>
                        <div className='shelf-item'>
                            <div className='shelf-item-name'>June 2023</div>
                            <div className='shelf-item-subname'>zettinator</div>
                            <div className='test-image'></div>
                        </div>
                    </div>
                    <div className='shelf-items'>
                        <div className='shelf-item'>
                            <div className='shelf-item-name'>June 2023</div>
                            <div className='shelf-item-subname'>zettinator</div>
                            <div className='test-image'></div>
                        </div>
                    </div>
                    <div className='shelf-items'>
                        <div className='shelf-item'>
                            <div className='shelf-item-name'>June 2023</div>
                            <div className='shelf-item-subname'>zettinator</div>
                            <div className='test-image'></div>
                        </div>
                    </div>
                    <div className='shelf-items'>
                        <div className='shelf-item'>
                            <div className='shelf-item-name'>June 2023</div>
                            <div className='shelf-item-subname'>zettinator</div>
                            <div className='test-image'></div>
                        </div>
                    </div>
                    
                </div>
                <hr/>
            </div>

        )
    } else {
        return (
            <div className='component-container'>
                <div className='shelf-title'>/ {props.title}</div>
                <div className='shelf-container'>
                    <div className='shelf-items'>
                        {props.items.map((item, index) => {
                            return (
                                <div className='shelf-item' key={index} onClick={() => props.onItemClick(item.uri)}>
                                    <div className='shelf-item-name'>{item.name}</div>
                                    <div className='shelf-item-subname'>{item.owner}</div>
                                    <img className='shelf-item-image' src={item.img} alt='playlist cover' />
                                </div>
                            )
                        })}
                    </div>

                </div>
                <hr/>
            </div>
        )
    }
}
